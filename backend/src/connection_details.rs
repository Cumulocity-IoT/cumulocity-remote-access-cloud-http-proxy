//! Extracts everything we need about an incoming proxied request: the device/config IDs from
//! the path, whether it is a websocket upgrade, the CRA auth query string, and the user/tenant
//! derived from the auth material. Port of `connection-details.ts`.

use base64::Engine;
use hyper::header::{HeaderMap, AUTHORIZATION, COOKIE, UPGRADE};
use serde::Deserialize;

const X_XSRF_TOKEN: &str = "x-xsrf-token";

#[derive(Debug, Clone)]
pub struct ConnectionDetails {
    pub device_id: String,
    pub config_id: String,
    pub tenant: Option<String>,
    pub user: Option<String>,
    pub is_websocket: bool,
    /// e.g. `?token=...&XSRF-TOKEN=...`, appended to the CRA websocket URL. May be empty.
    pub query_params_string: String,
    /// Snapshot of the original request headers (used to build the CRA websocket request).
    pub original_headers: HeaderMap,
}

impl ConnectionDetails {
    pub fn extract(
        device_id: String,
        config_id: String,
        headers: &HeaderMap,
    ) -> Self {
        let is_websocket = headers.contains_key(UPGRADE);
        let query_params_string = build_query_params_string(headers);
        let (tenant, user) = extract_tenant_user(headers)
            .map(|(t, u)| (Some(t), Some(u)))
            .unwrap_or((None, None));

        ConnectionDetails {
            device_id,
            config_id,
            tenant,
            user,
            is_websocket,
            query_params_string,
            original_headers: headers.clone(),
        }
    }

    /// Stable pool key, matching the original `RCAServerStore.getId`.
    pub fn pool_key(&self) -> String {
        format!(
            "{}/{}/{}/{}/{}",
            self.tenant.as_deref().unwrap_or(""),
            self.user.as_deref().unwrap_or(""),
            self.device_id,
            self.config_id,
            self.is_websocket
        )
    }
}

/// Build the `?token=...&XSRF-TOKEN=...` string from the request headers/cookies.
/// Port of `ConnectionDetails.getQueryParamsFromHeaders`.
fn build_query_params_string(headers: &HeaderMap) -> String {
    let authorization = header_str(headers, &AUTHORIZATION);
    let xsrf = headers.get(X_XSRF_TOKEN).and_then(|v| v.to_str().ok());
    let cookie = header_str(headers, &COOKIE);
    let xsrf2 = cookie.as_deref().and_then(|c| get_cookie(c, "XSRF-TOKEN"));

    let mut params: Vec<(String, String)> = Vec::new();
    if let Some(token) = authorization.as_deref() {
        if token != "Basic " {
            let token = token.strip_prefix("Basic ").unwrap_or(token);
            params.push(("token".to_string(), token.to_string()));
        }
    }
    if let Some(x) = xsrf.map(|s| s.to_string()).or(xsrf2) {
        params.push(("XSRF-TOKEN".to_string(), x));
    }

    if params.is_empty() {
        String::new()
    } else {
        let joined = params
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("&");
        format!("?{joined}")
    }
}

/// Extract `(tenant, user)` from Basic auth, a bearer JWT, or an `authorization` cookie.
/// Port of `ConnectionDetails.getUserAndTenantFromRequest`.
fn extract_tenant_user(headers: &HeaderMap) -> Option<(String, String)> {
    let authorization = header_str(headers, &AUTHORIZATION);
    let cookie = header_str(headers, &COOKIE);

    if let Some(auth) = authorization.as_deref() {
        if let Some(rest) = auth.strip_prefix("Basic ") {
            let decoded = base64_decode_str(rest)?;
            // `<tenant>/<user>:<password>`
            let tenant = decoded.split('/').next().unwrap_or("").to_string();
            let user = decoded
                .split(':')
                .next()
                .unwrap_or("")
                .rsplit('/')
                .next()
                .unwrap_or("")
                .to_string();
            return Some((tenant, user));
        }
    }

    // Otherwise look for a bearer JWT, preferring the `authorization` cookie.
    let mut bearer: Option<String> = cookie
        .as_deref()
        .and_then(|c| get_cookie(c, "authorization"));
    if bearer.is_none() {
        if let Some(auth) = authorization.as_deref() {
            if let Some(rest) = auth.strip_prefix("Bearer ") {
                bearer = Some(rest.to_string());
            }
        }
    }

    let token = bearer?;
    let payload_b64 = token.split('.').nth(1)?;
    let payload = base64_decode_str(payload_b64)?;
    #[derive(Deserialize)]
    struct Claims {
        sub: Option<String>,
        ten: Option<String>,
    }
    let claims: Claims = serde_json::from_str(&payload).ok()?;
    Some((claims.ten.unwrap_or_default(), claims.sub.unwrap_or_default()))
}

fn header_str(headers: &HeaderMap, name: &hyper::header::HeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

/// Find a single cookie value by name within a `Cookie:` header string.
pub fn get_cookie(cookie_header: &str, name: &str) -> Option<String> {
    for part in cookie_header.split(';') {
        let part = part.trim();
        if let Some((k, v)) = part.split_once('=') {
            if k.trim() == name {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

/// Tolerant base64 decode (handles standard, url-safe, and missing padding), returning UTF-8.
fn base64_decode_str(input: &str) -> Option<String> {
    let input = input.trim();
    let engines: [base64::engine::GeneralPurpose; 2] = [
        base64::engine::general_purpose::STANDARD_NO_PAD,
        base64::engine::general_purpose::URL_SAFE_NO_PAD,
    ];
    let trimmed = input.trim_end_matches('=');
    for engine in engines {
        if let Ok(bytes) = engine.decode(trimmed) {
            if let Ok(s) = String::from_utf8(bytes) {
                return Some(s);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::HeaderValue;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                hyper::header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn basic_auth_tenant_user() {
        // base64 of "t12345/john:secret"
        let token = base64::engine::general_purpose::STANDARD.encode("t12345/john:secret");
        let h = headers(&[("authorization", &format!("Basic {token}"))]);
        let (tenant, user) = extract_tenant_user(&h).unwrap();
        assert_eq!(tenant, "t12345");
        assert_eq!(user, "john");
    }

    #[test]
    fn bearer_jwt_tenant_user() {
        // payload {"sub":"alice","ten":"t999"}
        let payload =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"sub":"alice","ten":"t999"}"#);
        let jwt = format!("header.{payload}.sig");
        let h = headers(&[("authorization", &format!("Bearer {jwt}"))]);
        let (tenant, user) = extract_tenant_user(&h).unwrap();
        assert_eq!(tenant, "t999");
        assert_eq!(user, "alice");
    }

    #[test]
    fn cookie_jwt_preferred_over_bearer_header() {
        let payload =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"sub":"bob","ten":"t1"}"#);
        let jwt = format!("h.{payload}.s");
        let h = headers(&[("cookie", &format!("authorization={jwt}; other=x"))]);
        let (tenant, user) = extract_tenant_user(&h).unwrap();
        assert_eq!(tenant, "t1");
        assert_eq!(user, "bob");
    }

    #[test]
    fn query_params_from_basic_and_xsrf_cookie() {
        let h = headers(&[
            ("authorization", "Basic abc123"),
            ("cookie", "XSRF-TOKEN=tok; foo=bar"),
        ]);
        let q = build_query_params_string(&h);
        assert!(q.contains("token=abc123"));
        assert!(q.contains("XSRF-TOKEN=tok"));
        assert!(q.starts_with('?'));
    }

    #[test]
    fn no_query_params_when_empty_basic() {
        let h = headers(&[("authorization", "Basic ")]);
        assert_eq!(build_query_params_string(&h), "");
    }
}
