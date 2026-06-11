//! Request-side header/cookie rewriting applied before forwarding to the device.
//! Port of `header-adjustment.ts`.

use base64::Engine;
use hyper::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, COOKIE, USER_AGENT};

use crate::connection_details::get_cookie;

const HEADER_PREFIX: &str = "rca-http-header-";
const PROXY_COOKIE_PREFIX: &str = "cloud-http-proxy-";

/// Mutates `headers` in place: strips/keeps the Cumulocity auth material, re-injects the
/// `rca-http-header-<k>-<device>-<config>` custom headers, sets `User-Agent`, and derives an
/// `x-xsrf-token` header from the (already cleaned) cookie. Mirrors `HeaderAdjustment.adjust`.
pub fn adjust(headers: &mut HeaderMap, device_id: &str, config_id: &str) {
    adjust_authorization(headers);

    let suffix = format!("-{device_id}-{config_id}");

    let mut to_remove: Vec<HeaderName> = Vec::new();
    let mut to_add: Vec<(HeaderName, HeaderValue)> = Vec::new();

    for (key, value) in headers.iter() {
        let kstr = key.as_str(); // hyper lower-cases header names

        if kstr == "user-agent" {
            let ua = format!("{}/{}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"));
            if let Ok(v) = HeaderValue::from_str(&ua) {
                to_add.push((USER_AGENT, v));
            }
        }

        if !kstr.starts_with(HEADER_PREFIX) {
            continue;
        }

        // All rca-http-header-* headers are removed; only those targeting this device/config
        // are re-added under their real header name.
        to_remove.push(key.clone());
        if !kstr.ends_with(&suffix) {
            continue;
        }
        let new_key = kstr
            .strip_prefix(HEADER_PREFIX)
            .and_then(|k| k.strip_suffix(&suffix));
        if let Some(new_key) = new_key {
            if let Ok(name) = HeaderName::from_bytes(new_key.as_bytes()) {
                to_add.push((name, value.clone()));
            }
        }
    }

    for key in to_remove {
        headers.remove(&key);
    }
    for (key, value) in to_add {
        headers.insert(key, value);
    }

    // The XSRF token is taken from the cleaned cookie (where `cloud-http-proxy-XSRF-TOKEN`
    // has just been un-prefixed back to `XSRF-TOKEN`) and surfaced as a header for the device.
    if let Some(cookie) = headers.get(COOKIE).and_then(|v| v.to_str().ok()) {
        if let Some(xsrf) = get_cookie(cookie, "XSRF-TOKEN") {
            if let Ok(v) = HeaderValue::from_str(&xsrf) {
                headers.insert(HeaderName::from_static("x-xsrf-token"), v);
            }
        }
    }
}

fn adjust_authorization(headers: &mut HeaderMap) {
    let mut had_cookie_auth = false;

    if let Some(cookie) = headers.get(COOKIE).and_then(|v| v.to_str().ok()) {
        let (new_cookie, changed) = adjust_cookie(cookie);
        had_cookie_auth = changed;
        if new_cookie.is_empty() {
            headers.remove(COOKIE);
        } else if let Ok(v) = HeaderValue::from_str(&new_cookie) {
            headers.insert(COOKIE, v);
        }
    }

    if !had_cookie_auth {
        // Never forward the (fake) basic auth used for Cumulocity to the device.
        headers.remove(AUTHORIZATION);
        return;
    }

    // Auth was cookie-based, so keep a real authorization header but drop the fake basic one.
    let is_fake_basic = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|a| a.strip_prefix("Basic "))
        .and_then(|token| {
            base64::engine::general_purpose::STANDARD
                .decode(token)
                .ok()
                .and_then(|b| String::from_utf8(b).ok())
        })
        .map(|decoded| decoded.ends_with(":<fake password>"))
        .unwrap_or(false);

    if is_fake_basic {
        headers.remove(AUTHORIZATION);
    }
}

/// Removes the Cumulocity `authorization`/`XSRF-TOKEN` cookies and strips the
/// `cloud-http-proxy-` prefix the proxy added to device cookies. Returns the new cookie value
/// and whether anything auth-related changed (mirrors `adjustCookie`).
fn adjust_cookie(cookie: &str) -> (String, bool) {
    let mut kept: Vec<String> = Vec::new();
    let mut removed_auth = false;

    for segment in cookie.split(';') {
        let seg = segment.trim();
        if seg.is_empty() {
            continue;
        }
        let name = seg.split('=').next().unwrap_or("").trim();
        if name.eq_ignore_ascii_case("authorization") || name.eq_ignore_ascii_case("XSRF-TOKEN") {
            removed_auth = true;
            continue;
        }
        kept.push(seg.to_string());
    }

    let joined = kept.join("; ");
    let had_prefix = joined.contains(PROXY_COOKIE_PREFIX);
    let stripped = joined.replace(PROXY_COOKIE_PREFIX, "");
    (stripped, removed_auth || had_prefix)
}

/// The custom host configured for this device/config via a
/// `rca-http-header-host-<device>-<config>` header, if present. Port of `hasCustomHostHeader`
/// (extended to return the value, which also drives the TLS SNI).
pub fn custom_host(headers: &HeaderMap, device_id: &str, config_id: &str) -> Option<String> {
    let name = format!("{HEADER_PREFIX}host-{device_id}-{config_id}");
    headers
        .iter()
        .find(|(k, _)| k.as_str() == name)
        .and_then(|(_, v)| v.to_str().ok())
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn drops_basic_auth_when_no_cookie_auth() {
        let mut h = map(&[("authorization", "Basic dXNlcjpwYXNz")]);
        adjust(&mut h, "dev1", "cfg1");
        assert!(!h.contains_key(AUTHORIZATION));
    }

    #[test]
    fn keeps_real_authorization_with_cookie_auth_and_unprefixes_cookies() {
        // cookie carries the C8Y authorization (removed) plus a device cookie we prefixed.
        let mut h = map(&[
            ("authorization", "Bearer realtoken"),
            ("cookie", "authorization=jwt; cloud-http-proxy-session=abc"),
        ]);
        adjust(&mut h, "dev1", "cfg1");
        assert_eq!(h.get(AUTHORIZATION).unwrap(), "Bearer realtoken");
        let cookie = h.get(COOKIE).unwrap().to_str().unwrap();
        assert!(cookie.contains("session=abc"));
        assert!(!cookie.contains("cloud-http-proxy-"));
        assert!(!cookie.to_lowercase().contains("authorization="));
    }

    #[test]
    fn reinjects_custom_header_for_matching_device_config() {
        let mut h = map(&[
            ("rca-http-header-x-custom-dev1-cfg1", "hello"),
            ("rca-http-header-x-other-devX-cfgX", "ignored"),
            ("authorization", "Basic x"),
        ]);
        adjust(&mut h, "dev1", "cfg1");
        assert_eq!(h.get("x-custom").unwrap(), "hello");
        assert!(!h.keys().any(|k| k.as_str().starts_with("rca-http-header-")));
    }

    #[test]
    fn derives_xsrf_header_from_unprefixed_cookie() {
        let mut h = map(&[
            ("authorization", "Bearer t"),
            ("cookie", "authorization=jwt; cloud-http-proxy-XSRF-TOKEN=xyz"),
        ]);
        adjust(&mut h, "dev1", "cfg1");
        assert_eq!(h.get("x-xsrf-token").unwrap(), "xyz");
    }

    #[test]
    fn custom_host_detection() {
        let h = map(&[("rca-http-header-host-dev1-cfg1", "example.com")]);
        assert_eq!(custom_host(&h, "dev1", "cfg1").as_deref(), Some("example.com"));
        assert_eq!(custom_host(&h, "dev2", "cfg2"), None);
    }
}
