"""Minimal Web Push (RFC 8291 aes128gcm payload encryption + RFC 8292 VAPID), using only `cryptography`.

Works with iPhone home-screen web apps (iOS 16.4+), Android and desktop browsers.
Keys and subscriptions live in the working cache (never in git). Subscriptions are registered by the owner
through a GitHub issue titled "push-subscribe" that the app pre-fills; only issues opened by the repo owner count."""
from __future__ import annotations

import base64
import json
import os
import struct
import time
import urllib.error
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .core import iso, now_utc, p, read_json, write_json

b64u = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _pub_bytes(pub) -> bytes:
    return pub.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def load_or_create_vapid():
    f = p("cache", "vapid.json")
    d = read_json(f)
    if d and d.get("private"):
        priv = serialization.load_pem_private_key(d["private"].encode(), None)
    else:
        priv = ec.generate_private_key(ec.SECP256R1())
        d = {"private": priv.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                           serialization.NoEncryption()).decode(),
             "created": iso(now_utc())}
        write_json(f, d)
    pub = b64u(_pub_bytes(priv.public_key()))
    write_json(p("public", "vapid.json"), {"publicKey": pub})
    return priv, pub


def _hkdf(salt, ikm, info, length):
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def encrypt(payload: bytes, p256dh: str, auth: str) -> bytes:
    ua_pub = unb64u(p256dh)
    auth_secret = unb64u(auth)
    as_priv = ec.generate_private_key(ec.SECP256R1())
    as_pub = _pub_bytes(as_priv.public_key())
    shared = as_priv.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub))
    ikm = _hkdf(auth_secret, shared, b"WebPush: info\x00" + ua_pub + as_pub, 32)
    salt = os.urandom(16)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    ct = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    rs = 4096
    return salt + struct.pack("!IB", rs, len(as_pub)) + as_pub + ct


def vapid_header(priv, endpoint: str, sub: str) -> str:
    u = urllib.parse.urlparse(endpoint)
    aud = f"{u.scheme}://{u.netloc}"
    header = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    claims = b64u(json.dumps({"aud": aud, "exp": int(time.time()) + 12 * 3600, "sub": sub},
                             separators=(",", ":")).encode())
    signing = f"{header}.{claims}".encode()
    der = priv.sign(signing, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    sig = b64u(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    pub = b64u(_pub_bytes(priv.public_key()))
    return f"vapid t={header}.{claims}.{sig}, k={pub}"


def send_one(priv, sub: dict, message: dict, contact: str, ttl=6 * 3600, urgency="high"):
    body = encrypt(json.dumps(message, ensure_ascii=False).encode(), sub["keys"]["p256dh"], sub["keys"]["auth"])
    req = urllib.request.Request(sub["endpoint"], data=body, method="POST", headers={
        "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "TTL": str(ttl),
        "Urgency": urgency, "Authorization": vapid_header(priv, sub["endpoint"], contact)})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def subscriptions() -> list:
    return read_json(p("cache", "push_subscriptions.json"), []) or []


def save_subscriptions(subs):
    write_json(p("cache", "push_subscriptions.json"), subs)


def contact():
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    return f"https://github.com/{repo}" if repo else "mailto:noreply@example.invalid"


def broadcast(message: dict, urgency="high") -> list:
    subs = subscriptions()
    if not subs:
        return []
    priv, _ = load_or_create_vapid()
    keep, recs = [], []
    for s in subs:
        st = send_one(priv, s, message, contact(), urgency=urgency)
        recs.append({"endpoint_host": urllib.parse.urlparse(s["endpoint"]).netloc, "status": st})
        if st not in (404, 410):     # expired subscriptions are dropped
            keep.append(s)
    save_subscriptions(keep)
    return recs


def _gh(method, path, body=None):
    tok, repo = os.environ.get("GITHUB_TOKEN"), os.environ.get("GITHUB_REPOSITORY")
    if not tok or not repo:
        return None
    req = urllib.request.Request(f"https://api.github.com/repos/{repo}{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json",
                                          "User-Agent": "fpl-radar", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read() or b"null")


def register_from_issues() -> int:
    """Pick up subscription requests: open issues titled 'push-subscribe' opened by the repo owner."""
    owner = os.environ.get("GITHUB_REPOSITORY_OWNER", "").lower()
    try:
        issues = _gh("GET", "/issues?state=open&per_page=30") or []
    except Exception:
        return 0
    subs = subscriptions()
    added = 0
    priv, pub = load_or_create_vapid()
    for it in issues:
        if not it.get("title", "").lower().startswith("push-subscribe") or "pull_request" in it:
            continue
        ok = (it.get("user", {}).get("login", "").lower() == owner)
        msg = "Ignored: only the repository owner can register notifications."
        if ok:
            try:
                body = it.get("body") or ""
                sub = json.loads(body[body.index("{"):body.rindex("}") + 1])
                assert sub["endpoint"].startswith("https://") and sub["keys"]["p256dh"] and sub["keys"]["auth"]
                subs = [s for s in subs if s["endpoint"] != sub["endpoint"]] + [
                    {"endpoint": sub["endpoint"], "keys": sub["keys"], "added": iso(now_utc())}]
                save_subscriptions(subs)
                st = send_one(priv, subs[-1], {"title": "FPL Radar", "body": "Notifications are on ✓",
                                                "url": "./"}, contact())
                msg = f"Subscribed ✓ (test notification status {st}). You can close the app; alerts will arrive as notifications."
                added += 1
            except Exception as e:
                msg = f"Could not read the subscription: {type(e).__name__}. Please tap 'Enable notifications' again."
        try:
            _gh("POST", f"/issues/{it['number']}/comments", {"body": msg})
            _gh("PATCH", f"/issues/{it['number']}", {"state": "closed", "state_reason": "completed"})
        except Exception:
            pass
    return added
