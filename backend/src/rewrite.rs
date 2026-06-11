//! Response-side rewriting that mirrors the `http-proxy` options assembled in
//! `getRewriteOptions` plus the `prefixCookiesToBeSet` proxyRes handler from `index.ts`:
//! redirect `Location` host/protocol rewriting, `Set-Cookie` `Path`/`Domain` rewriting, and the
//! `cloud-http-proxy-` cookie-name prefix.

use hyper::header::{HeaderMap, HeaderValue, LOCATION, SET_COOKIE};
use hyper::StatusCode;

const PROXY_COOKIE_PREFIX: &str = "cloud-http-proxy-";

/// The set of options derived per request, equivalent to the `Server.ServerOptions` returned by
/// `getRewriteOptions`.
#[derive(Debug, Clone)]
pub struct RewriteOptions {
    /// `${host}/service/cloud-http-proxy[/s]/<device>/<config>` — used as the redirect host.
    pub host_rewrite: String,
    /// Scheme used when rewriting redirect `Location` headers (`x-forwarded-proto` or `http`).
    pub protocol_rewrite: String,
    /// `.<forwarded-host-without-port>`, or `None` when no `x-forwarded-host` was present.
    pub cookie_domain_rewrite: Option<String>,
    /// `/service/cloud-http-proxy[/s]/<device>/<config>/` — path written onto every cookie.
    pub cookie_path_rewrite: String,
}

impl RewriteOptions {
    /// Build the options from the incoming request headers. `secure` selects the `/s` path
    /// segment. NOTE: the original `index.ts` passes `secure = true` for *both* routes when
    /// computing these options, so callers replicate that to preserve behaviour.
    pub fn build(headers: &HeaderMap, device_id: &str, config_id: &str, secure: bool) -> Self {
        let forwarded_host = headers
            .get("x-forwarded-host")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let host = forwarded_host.clone().or_else(|| {
            headers
                .get(hyper::header::HOST)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
        });
        let host = host.unwrap_or_default();

        let s = if secure { "/s" } else { "" };
        let host_rewrite =
            format!("{host}/service/cloud-http-proxy{s}/{device_id}/{config_id}");
        let cookie_path_rewrite =
            format!("/service/cloud-http-proxy{s}/{device_id}/{config_id}/");

        let protocol_rewrite = headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "http".to_string());

        let cookie_domain_rewrite = forwarded_host.map(|fh| {
            // strip the port: `.replace(/:.*$/, "")`
            let host_only = fh.split(':').next().unwrap_or(&fh);
            format!(".{host_only}")
        });

        RewriteOptions {
            host_rewrite,
            protocol_rewrite,
            cookie_domain_rewrite,
            cookie_path_rewrite,
        }
    }
}

/// Apply all response rewrites in place.
pub fn apply(headers: &mut HeaderMap, status: StatusCode, opts: &RewriteOptions) {
    rewrite_location(headers, status, opts);
    rewrite_set_cookies(headers, opts);
}

/// http-proxy `setRedirectHostRewrite`: on redirect responses, replace the `Location` host with
/// `host_rewrite` and the protocol with `protocol_rewrite`.
fn rewrite_location(headers: &mut HeaderMap, status: StatusCode, opts: &RewriteOptions) {
    let redirect = matches!(
        status,
        StatusCode::CREATED
            | StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    );
    if !redirect {
        return;
    }

    let Some(location) = headers.get(LOCATION).and_then(|v| v.to_str().ok()) else {
        return;
    };

    // Keep the path+query, drop any existing scheme/authority, then prepend the rewritten host.
    let rest = match location.split_once("://") {
        Some((_scheme, after)) => match after.find('/') {
            Some(idx) => after[idx..].to_string(),
            None => String::new(),
        },
        None => location.to_string(),
    };
    let new_location = format!("{}://{}{}", opts.protocol_rewrite, opts.host_rewrite, rest);
    if let Ok(v) = HeaderValue::from_str(&new_location) {
        headers.insert(LOCATION, v);
    }
}

/// Rewrite the `Path`/`Domain` attributes and prefix the cookie name with `cloud-http-proxy-`.
fn rewrite_set_cookies(headers: &mut HeaderMap, opts: &RewriteOptions) {
    let cookies: Vec<String> = headers
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .collect();
    if cookies.is_empty() {
        return;
    }

    headers.remove(SET_COOKIE);
    for cookie in cookies {
        let rewritten = rewrite_one_cookie(&cookie, opts);
        if let Ok(v) = HeaderValue::from_str(&rewritten) {
            headers.append(SET_COOKIE, v);
        }
    }
}

fn rewrite_one_cookie(cookie: &str, opts: &RewriteOptions) -> String {
    let mut parts: Vec<String> = cookie.split(';').map(|s| s.trim().to_string()).collect();
    set_attribute(&mut parts, "Path", &opts.cookie_path_rewrite);
    if let Some(domain) = &opts.cookie_domain_rewrite {
        set_attribute(&mut parts, "Domain", domain);
    }
    let joined = parts.join("; ");
    format!("{PROXY_COOKIE_PREFIX}{joined}")
}

/// Replace an existing `attr=...` (case-insensitive) attribute, or append it if absent.
fn set_attribute(parts: &mut Vec<String>, attr: &str, value: &str) {
    let new_part = format!("{attr}={value}");
    for part in parts.iter_mut().skip(1) {
        let name = part.split('=').next().unwrap_or("").trim();
        if name.eq_ignore_ascii_case(attr) {
            *part = new_part;
            return;
        }
    }
    parts.push(new_part);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> RewriteOptions {
        RewriteOptions {
            host_rewrite: "example.com/service/cloud-http-proxy/dev1/cfg1".to_string(),
            protocol_rewrite: "https".to_string(),
            cookie_domain_rewrite: Some(".example.com".to_string()),
            cookie_path_rewrite: "/service/cloud-http-proxy/dev1/cfg1/".to_string(),
        }
    }

    #[test]
    fn prefixes_and_rewrites_set_cookie() {
        let out = rewrite_one_cookie("session=abc; Path=/; HttpOnly", &opts());
        assert!(out.starts_with("cloud-http-proxy-session=abc"));
        assert!(out.contains("Path=/service/cloud-http-proxy/dev1/cfg1/"));
        assert!(out.contains("Domain=.example.com"));
        assert!(out.contains("HttpOnly"));
        assert!(!out.contains("Path=/;"));
    }

    #[test]
    fn appends_path_when_missing() {
        let out = rewrite_one_cookie("token=xyz", &opts());
        assert!(out.contains("Path=/service/cloud-http-proxy/dev1/cfg1/"));
    }

    #[test]
    fn rewrites_redirect_location_absolute() {
        let mut h = HeaderMap::new();
        h.insert(LOCATION, HeaderValue::from_static("http://device.local/foo?a=1"));
        apply(&mut h, StatusCode::FOUND, &opts());
        assert_eq!(
            h.get(LOCATION).unwrap(),
            "https://example.com/service/cloud-http-proxy/dev1/cfg1/foo?a=1"
        );
    }

    #[test]
    fn rewrites_redirect_location_relative() {
        let mut h = HeaderMap::new();
        h.insert(LOCATION, HeaderValue::from_static("/login"));
        apply(&mut h, StatusCode::MOVED_PERMANENTLY, &opts());
        assert_eq!(
            h.get(LOCATION).unwrap(),
            "https://example.com/service/cloud-http-proxy/dev1/cfg1/login"
        );
    }

    #[test]
    fn leaves_location_on_non_redirect() {
        let mut h = HeaderMap::new();
        h.insert(LOCATION, HeaderValue::from_static("http://device.local/foo"));
        apply(&mut h, StatusCode::OK, &opts());
        assert_eq!(h.get(LOCATION).unwrap(), "http://device.local/foo");
    }
}
