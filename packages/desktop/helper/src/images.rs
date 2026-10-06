//! Detach screenshot data-URLs from tool JSON so DSH can admit ImageBlocks.

use serde_json::{json, Value};

pub fn detach_images(payload: Value) -> (Value, Vec<Value>) {
    let mut images = Vec::new();
    let stripped = walk(payload, "screenshot", &mut images);
    (stripped, images)
}

fn walk(node: Value, hint: &str, images: &mut Vec<Value>) -> Value {
    match node {
        Value::Array(items) => Value::Array(items.into_iter().map(|item| walk(item, hint, images)).collect()),
        Value::Object(map) => {
            let child_lists = map.get("screenshots").map(Value::is_array).unwrap_or(false)
                || map.get("images").map(Value::is_array).unwrap_or(false);
            let mut out = map;
            if !child_lists {
                // TC-08/TC-09: the official `Screenshot.url` IS the data URL and the
                // element carries exactly `{height,id,originX,originY,url,width,zIndex}`.
                // DSH ships the pixels as an ImageBlock, so the inline base64 must never
                // reach the model as text: drop the key entirely instead of emitting the
                // non-official `url: ""` + `emitted: true` pair.
                let name = out
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or(hint)
                    .to_string();
                let parsed = out.get("url").and_then(Value::as_str).and_then(from_data_url);
                if let Some((mime, data)) = parsed {
                    images.push(json!({"mimeType": mime, "data": data, "name": name}));
                    out.remove("url");
                }
            }
            let keys: Vec<String> = out.keys().cloned().collect();
            for key in keys {
                if let Some(child) = out.remove(&key) {
                    out.insert(key, walk(child, hint, images));
                }
            }
            Value::Object(out)
        }
        other => other,
    }
}

fn from_data_url(url: &str) -> Option<(String, String)> {
    if !url.starts_with("data:image") {
        return None;
    }
    let (header, b64) = url.split_once(',')?;
    let mime = header
        .trim_start_matches("data:")
        .split(';')
        .next()
        .unwrap_or("image/jpeg")
        .to_string();
    if b64.len() < 32 {
        return None;
    }
    Some((mime, b64.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shot_payload(id: &str, url: Value) -> Value {
        json!({
            "window": {"id": 1},
            "screenshots": [{
                "id": id,
                "zIndex": 0,
                "url": url,
                "originX": 0,
                "originY": 0,
                "width": 10,
                "height": 10,
            }],
        })
    }

    // TC-08/TC-09: a detached screenshot must not keep the inline data URL (DSH ships
    // it as an ImageBlock) and must not gain the non-official `emitted` field. The
    // pre-fix code did `url: ""` + `emitted: true`, so both assertions are red on it.
    #[test]
    fn detached_screenshot_drops_url_and_never_invents_emitted() {
        let data = format!("data:image/jpeg;base64,{}", "A".repeat(64));
        let (stripped, images) = detach_images(shot_payload("screenshot-0", json!(data)));
        let shot = &stripped["screenshots"][0];
        assert_eq!(images.len(), 1);
        assert_eq!(images[0]["mimeType"], "image/jpeg");
        assert_eq!(images[0]["name"], "screenshot-0");
        assert_eq!(images[0]["data"], "A".repeat(64));
        assert!(shot.get("url").is_none(), "url must be omitted, got {:?}", shot.get("url"));
        assert!(shot.get("emitted").is_none(), "emitted is not an official Screenshot field");
        // The official element keeps the other six fields.
        for key in ["id", "zIndex", "originX", "originY", "width", "height"] {
            assert!(shot.get(key).is_some(), "official field {key} must survive");
        }
    }

    #[test]
    fn non_image_url_is_left_untouched() {
        let (stripped, images) = detach_images(shot_payload("screenshot-1", json!("https://example.test/a.png")));
        assert!(images.is_empty());
        assert_eq!(stripped["screenshots"][0]["url"], "https://example.test/a.png");
    }

    #[test]
    fn top_level_url_is_detached_and_dropped() {
        let (stripped, images) = detach_images(json!({
            "id": "shot-7",
            "url": format!("data:image/png;base64,{}", "B".repeat(64)),
        }));
        assert_eq!(images.len(), 1);
        assert_eq!(images[0]["name"], "shot-7");
        assert!(stripped.get("url").is_none());
    }
}
