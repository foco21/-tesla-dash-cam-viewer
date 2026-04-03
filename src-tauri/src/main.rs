#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use tauri::Manager;
use base64::Engine as _;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct EventClips {
    front: Option<String>,
    back: Option<String>,
    left: Option<String>,
    right: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DashcamEvent {
    key: String,
    date_iso: Option<String>,
    clips: EventClips,
    event_json: Option<EventJsonMeta>,
    event_mp4: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct EventJsonMeta {
    timestamp: Option<String>,
    city: Option<String>,
    street: Option<String>,
    est_lat: Option<f64>,
    est_lon: Option<f64>,
    reason: Option<String>,
    camera: Option<String>,
    source_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GpsData {
    latitude: f64,
    longitude: f64,
    altitude_meters: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ClipMetadata {
    creation_time: Option<String>,
    gps: Option<GpsData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportRequest {
    output_path: String,
    main_camera: String,
    clips: EventClips,
    telemetry_png_frames: Option<Vec<JsTelemetryPngFrame>>,
    overlay_duration_sec: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsTelemetryPngFrame {
    time_sec: f64,
    png_data_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExportResponse {
    output_path: String,
    ffmpeg_stdout: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PickExportPathRequest {
    current_path: Option<String>,
}

static WORKING_GPU_ENCODER: OnceLock<Option<String>> = OnceLock::new();

fn detect_camera(file_name: &str) -> Option<&'static str> {
    let name = file_name.to_lowercase();
    if name.contains("front") {
        Some("front")
    } else if name.contains("back") {
        Some("back")
    } else if name.contains("left_repeater") || name.contains("left-repeater") || name.contains("left") {
        Some("left")
    } else if name.contains("right_repeater") || name.contains("right-repeater") || name.contains("right") {
        Some("right")
    } else {
        None
    }
}

fn strip_camera_suffix(stem: &str) -> String {
    let lower = stem.to_lowercase();
    let suffixes = [
        "-front",
        "_front",
        "-back",
        "_back",
        "-left_repeater",
        "_left_repeater",
        "-right_repeater",
        "_right_repeater",
        "-left",
        "_left",
        "-right",
        "_right",
    ];

    for suffix in suffixes {
        if lower.ends_with(suffix) {
            return stem[..stem.len() - suffix.len()].to_string();
        }
    }

    stem.to_string()
}

fn parse_date_iso(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    if bytes.len() < 19 {
        return None;
    }

    for i in 0..=(bytes.len() - 19) {
        let s = &text[i..(i + 19)];
        let chars: Vec<char> = s.chars().collect();
        if chars.len() != 19 {
            continue;
        }
        let ok = chars[4] == '-'
            && chars[7] == '-'
            && (chars[10] == '_' || chars[10] == ' ')
            && chars[13] == '-'
            && chars[16] == '-'
            && chars
                .iter()
                .enumerate()
                .all(|(idx, c)| [4, 7, 10, 13, 16].contains(&idx) || c.is_ascii_digit());

        if ok {
            let mut out = s.replace('_', "T").replace(' ', "T");
            out.replace_range(13..14, ":");
            out.replace_range(16..17, ":");
            return Some(out);
        }
    }

    None
}

fn collect_video_paths(root: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(root).map_err(|e| format!("read_dir failed for {}: {}", root.display(), e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("read_dir entry error: {}", e))?;
        let path = entry.path();

        if path.is_dir() {
            collect_video_paths(&path, out)?;
            continue;
        }

        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();

        if ext == "mp4" || ext == "mov" {
            out.push(path);
        }
    }

    Ok(())
}

fn parse_json_f64(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(v) if v.is_number() => v.as_f64(),
        Some(v) if v.is_string() => v.as_str().and_then(|s| s.parse::<f64>().ok()),
        _ => None,
    }
}

fn read_event_json(dir: &Path) -> Option<EventJsonMeta> {
    let json_path = dir.join("event.json");
    if !json_path.exists() {
        return None;
    }

    let bytes = fs::read(&json_path).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let obj = value.as_object()?;

    Some(EventJsonMeta {
        timestamp: obj.get("timestamp").and_then(|v| v.as_str()).map(|s| s.to_string()),
        city: obj.get("city").and_then(|v| v.as_str()).map(|s| s.to_string()),
        street: obj.get("street").and_then(|v| v.as_str()).map(|s| s.to_string()),
        est_lat: parse_json_f64(obj.get("est_lat")),
        est_lon: parse_json_f64(obj.get("est_lon")),
        reason: obj.get("reason").and_then(|v| v.as_str()).map(|s| s.to_string()),
        camera: obj.get("camera").and_then(|v| v.as_str()).map(|s| s.to_string()),
        source_path: Some(json_path.to_string_lossy().to_string()),
    })
}

fn read_event_mp4(dir: &Path) -> Option<String> {
    let p = dir.join("event.mp4");
    if p.exists() {
        Some(p.to_string_lossy().to_string())
    } else {
        None
    }
}

#[tauri::command]
fn scan_teslacam(root_path: String) -> Result<Vec<DashcamEvent>, String> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err("Provided path does not exist or is not a directory".to_string());
    }

    let mut files = Vec::new();
    collect_video_paths(&root, &mut files)?;

    let mut grouped: HashMap<String, DashcamEvent> = HashMap::new();
    let mut event_json_cache: HashMap<String, Option<EventJsonMeta>> = HashMap::new();
    let mut event_mp4_cache: HashMap<String, Option<String>> = HashMap::new();

    for path in files {
        let file_name = match path.file_name().and_then(|s| s.to_str()) {
            Some(v) => v,
            None => continue,
        };

        let camera = match detect_camera(file_name) {
            Some(v) => v,
            None => continue,
        };

        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(strip_camera_suffix)
            .unwrap_or_else(|| "unknown".to_string());

        let parent_dir = match path.parent() {
            Some(p) => p,
            None => continue,
        };
        let parent = parent_dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown");

        let parent_key = parent_dir.to_string_lossy().to_string();
        let event_json = if let Some(v) = event_json_cache.get(&parent_key) {
            v.clone()
        } else {
            let v = read_event_json(parent_dir);
            event_json_cache.insert(parent_key.clone(), v.clone());
            v
        };
        let event_mp4 = if let Some(v) = event_mp4_cache.get(&parent_key) {
            v.clone()
        } else {
            let v = read_event_mp4(parent_dir);
            event_mp4_cache.insert(parent_key, v.clone());
            v
        };

        let key = format!("{}/{}", parent, stem);
        let date_iso = parse_date_iso(&key).or_else(|| parse_date_iso(file_name));
        let event = grouped.entry(key.clone()).or_insert(DashcamEvent {
            key,
            date_iso,
            clips: EventClips::default(),
            event_json,
            event_mp4,
        });

        let p = path.to_string_lossy().to_string();
        match camera {
            "front" => event.clips.front = Some(p),
            "back" => event.clips.back = Some(p),
            "left" => event.clips.left = Some(p),
            "right" => event.clips.right = Some(p),
            _ => {}
        }
    }

    let mut events: Vec<DashcamEvent> = grouped.into_values().collect();
    events.sort_by(|a, b| b.date_iso.cmp(&a.date_iso).then(a.key.cmp(&b.key)));

    Ok(events)
}

fn parse_iso6709(input: &str) -> Option<GpsData> {
    let s = input.trim().trim_end_matches('/');
    if s.len() < 3 {
        return None;
    }

    let bytes = s.as_bytes();
    if bytes[0] != b'+' && bytes[0] != b'-' {
        return None;
    }

    let mut second_sign = None;
    for (idx, b) in bytes.iter().enumerate().skip(1) {
        if *b == b'+' || *b == b'-' {
            second_sign = Some(idx);
            break;
        }
    }
    let second = second_sign?;

    let mut third_sign = None;
    for (idx, b) in bytes.iter().enumerate().skip(second + 1) {
        if *b == b'+' || *b == b'-' {
            third_sign = Some(idx);
            break;
        }
    }

    let lat = s[0..second].parse::<f64>().ok()?;
    let lon_end = third_sign.unwrap_or(s.len());
    let lon = s[second..lon_end].parse::<f64>().ok()?;
    let alt = third_sign.and_then(|idx| s[idx..].parse::<f64>().ok());

    Some(GpsData {
        latitude: lat,
        longitude: lon,
        altitude_meters: alt,
    })
}

fn extract_metadata_from_ffprobe(json_bytes: &[u8]) -> Result<ClipMetadata, String> {
    let value: Value = serde_json::from_slice(json_bytes).map_err(|e| format!("ffprobe JSON parse failed: {}", e))?;

    let mut creation_time = None;
    let mut gps_raw = None;

    if let Some(tags) = value
        .get("format")
        .and_then(|f| f.get("tags"))
        .and_then(|t| t.as_object())
    {
        for (k, v) in tags {
            let key = k.to_ascii_lowercase();
            let val = v.as_str().unwrap_or_default().to_string();
            if key == "creation_time" && creation_time.is_none() {
                creation_time = Some(val.clone());
            }
            if (key.contains("location") || key.contains("gps")) && gps_raw.is_none() {
                gps_raw = Some(val.clone());
            }
        }
    }

    if let Some(streams) = value.get("streams").and_then(|s| s.as_array()) {
        for stream in streams {
            if let Some(tags) = stream.get("tags").and_then(|t| t.as_object()) {
                for (k, v) in tags {
                    let key = k.to_ascii_lowercase();
                    let val = v.as_str().unwrap_or_default().to_string();
                    if key == "creation_time" && creation_time.is_none() {
                        creation_time = Some(val.clone());
                    }
                    if (key.contains("location") || key.contains("gps")) && gps_raw.is_none() {
                        gps_raw = Some(val.clone());
                    }
                }
            }
        }
    }

    let gps = gps_raw.and_then(|raw| parse_iso6709(&raw));

    Ok(ClipMetadata { creation_time, gps })
}

fn resolve_tool(tool_name: &str) -> String {
    if Command::new(tool_name).arg("-version").output().is_ok() {
        return tool_name.to_string();
    }

    let profile = env::var("USERPROFILE").unwrap_or_default();
    let env_hint = match tool_name {
        "ffprobe" => env::var("FFPROBE_PATH").ok(),
        "ffmpeg" => env::var("FFMPEG_PATH").ok(),
        _ => None,
    };

    let mut candidates = Vec::new();
    if let Some(hint) = env_hint {
        candidates.push(PathBuf::from(hint));
    }
    if !profile.is_empty() {
        candidates.push(PathBuf::from(format!("{}\\.stacher\\{}.exe", profile, tool_name)));
        candidates.push(PathBuf::from(format!("{}\\scoop\\apps\\ffmpeg\\current\\bin\\{}.exe", profile, tool_name)));
    }

    for path in candidates {
        if path.exists() {
            return path.to_string_lossy().to_string();
        }
    }

    tool_name.to_string()
}

#[tauri::command]
fn read_clip_metadata(clip_path: String) -> Result<ClipMetadata, String> {
    let ffprobe_bin = resolve_tool("ffprobe");
    let out = Command::new(&ffprobe_bin)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_entries",
            "format_tags:stream_tags",
            &clip_path,
        ])
        .output()
        .map_err(|e| format!("Failed to execute ffprobe: {}", e))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(format!("ffprobe failed: {}", stderr));
    }

    extract_metadata_from_ffprobe(&out.stdout)
}

fn choose_main_path(req: &ExportRequest) -> Option<String> {
    match req.main_camera.as_str() {
        "front" => req.clips.front.clone(),
        "back" => req.clips.back.clone(),
        "left" => req.clips.left.clone(),
        "right" => req.clips.right.clone(),
        _ => None,
    }
    .or_else(|| req.clips.front.clone())
    .or_else(|| req.clips.left.clone())
    .or_else(|| req.clips.right.clone())
    .or_else(|| req.clips.back.clone())
}

fn detect_ffmpeg_encoders(ffmpeg_bin: &str) -> Vec<String> {
    let out = Command::new(ffmpeg_bin).args(["-hide_banner", "-encoders"]).output();
    if let Ok(result) = out {
        if result.status.success() {
            let text = String::from_utf8_lossy(&result.stdout).to_lowercase();
            let mut encoders = Vec::new();
            for name in ["h264_nvenc", "h264_qsv", "h264_amf"] {
                if text.contains(name) {
                    encoders.push(name.to_string());
                }
            }
            return encoders;
        }
    }
    Vec::new()
}

fn ffmpeg_encoder_smoke_test(ffmpeg_bin: &str, codec: &str) -> bool {
    let out = Command::new(ffmpeg_bin)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=128x72:r=30:d=0.2",
            "-frames:v",
            "1",
            "-an",
            "-c:v",
            codec,
            "-f",
            "null",
            "-",
        ])
        .output();

    matches!(out, Ok(result) if result.status.success())
}

fn detect_working_gpu_encoder(ffmpeg_bin: &str) -> Option<String> {
    let available = detect_ffmpeg_encoders(ffmpeg_bin);
    for codec in ["h264_nvenc", "h264_qsv", "h264_amf"] {
        if available.iter().any(|c| c == codec) && ffmpeg_encoder_smoke_test(ffmpeg_bin, codec) {
            return Some(codec.to_string());
        }
    }
    None
}

fn working_gpu_encoder(ffmpeg_bin: &str) -> Option<String> {
    WORKING_GPU_ENCODER
        .get_or_init(|| detect_working_gpu_encoder(ffmpeg_bin))
        .clone()
}

fn encoder_args_for(codec: &str) -> Vec<String> {
    match codec {
        // Nvidia NVENC
        "h264_nvenc" => vec![
            "-c:v".into(),
            "h264_nvenc".into(),
            "-preset".into(),
            "p5".into(),
            "-tune".into(),
            "hq".into(),
            "-rc".into(),
            "vbr".into(),
            "-cq".into(),
            "22".into(),
            "-b:v".into(),
            "0".into(),
        ],
        // Intel Quick Sync
        "h264_qsv" => vec![
            "-c:v".into(),
            "h264_qsv".into(),
            "-preset".into(),
            "medium".into(),
            "-global_quality".into(),
            "23".into(),
            "-look_ahead".into(),
            "0".into(),
        ],
        // AMD AMF
        "h264_amf" => vec![
            "-c:v".into(),
            "h264_amf".into(),
            "-usage".into(),
            "transcoding".into(),
            "-quality".into(),
            "quality".into(),
            "-rc".into(),
            "cqp".into(),
            "-qp_i".into(),
            "22".into(),
            "-qp_p".into(),
            "24".into(),
        ],
        // CPU fallback
        _ => vec![
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "fast".into(),
            "-crf".into(),
            "20".into(),
        ],
    }
}

fn read_video_duration_seconds(clip_path: &str) -> Option<f64> {
    let ffprobe_bin = resolve_tool("ffprobe");
    let out = Command::new(&ffprobe_bin)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
            clip_path,
        ])
        .output()
        .ok()?;

    if !out.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().next()?.trim();
    first.parse::<f64>().ok().filter(|v| v.is_finite() && *v > 0.0)
}

fn build_export_ffmpeg_args(
    main: &str,
    previews: &[String],
    filter: &str,
    codec: &str,
    output_path: &str,
    max_duration_s: Option<f64>,
    overlay_concat: Option<&Path>,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-nostats".into(),
        "-progress".into(),
        "pipe:2".into(),
        "-fflags".into(),
        "+genpts".into(),
        "-i".into(),
        main.to_string(),
    ];
    for p in previews {
        args.push("-i".into());
        args.push(p.clone());
    }
    if let Some(path) = overlay_concat {
        args.push("-f".into());
        args.push("concat".into());
        args.push("-safe".into());
        args.push("0".into());
        args.push("-i".into());
        args.push(path.to_string_lossy().to_string());
    }
    args.extend([
        "-filter_complex".into(),
        filter.to_string(),
        "-map".into(),
        "[outvfps]".into(),
    ]);
    if let Some(seconds) = max_duration_s {
        // Clamp output duration so the filter graph cannot run past the main clip.
        args.push("-t".into());
        args.push(format!("{:.3}", seconds));
    }
    args.extend(encoder_args_for(codec));
    args.extend([
        "-r".into(),
        "30".into(),
        "-fps_mode".into(),
        "cfr".into(),
        "-g".into(),
        "60".into(),
        "-keyint_min".into(),
        "60".into(),
        "-sc_threshold".into(),
        "0".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-video_track_timescale".into(),
        "90000".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-an".into(),
        output_path.to_string(),
    ]);
    args
}

fn with_telemetry_filter(base_filter: &str, overlay_input_index: Option<usize>) -> String {
    if let Some(idx) = overlay_input_index {
        base_filter.replace(
            ";[outv]fps=30[outvfps]",
            &format!(
                ";[{}:v]format=rgba[ovl];[outv][ovl]overlay=0:0:eof_action=pass:shortest=0[outovl];[outovl]fps=30[outvfps]",
                idx
            ),
        )
    } else {
        base_filter.to_string()
    }
}

fn normalize_output_path(raw_path: &str) -> String {
    let trimmed = raw_path.trim();
    let p = PathBuf::from(trimmed);
    let looks_like_dir = p.is_dir() || trimmed.ends_with('\\') || trimmed.ends_with('/');

    if looks_like_dir {
        return p
            .join("teslacam-export.mp4")
            .to_string_lossy()
            .to_string();
    }

    if p.extension().is_none() {
        return format!("{}.mp4", trimmed);
    }

    trimmed.to_string()
}

fn parse_png_data_url(data_url: &str) -> Option<Vec<u8>> {
    let trimmed = data_url.trim();
    let marker = ";base64,";
    if !trimmed.starts_with("data:image/png") {
        return None;
    }
    let split = trimmed.find(marker)?;
    let payload = &trimmed[(split + marker.len())..];
    base64::engine::general_purpose::STANDARD.decode(payload.as_bytes()).ok()
}

fn ffconcat_escape_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "\\'")
}

fn write_telemetry_png_overlay_from_js_frames_temp(
    frames: &[JsTelemetryPngFrame],
    duration_s: f64,
) -> Option<(PathBuf, PathBuf)> {
    if frames.is_empty() || !duration_s.is_finite() || duration_s <= 0.0 {
        return None;
    }

    let mut sorted = frames.to_vec();
    sorted.sort_by(|a, b| a.time_sec.partial_cmp(&b.time_sec).unwrap_or(std::cmp::Ordering::Equal));

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    let mut dir = env::temp_dir();
    dir.push(format!("teslacam_telemetry_png_{}", nonce));
    fs::create_dir_all(&dir).ok()?;

    let mut timed_files: Vec<(f64, PathBuf)> = Vec::new();
    for (i, frame) in sorted.iter().enumerate() {
        let t = frame.time_sec.clamp(0.0, duration_s);
        if let Some(bytes) = parse_png_data_url(&frame.png_data_url) {
            let file_path = dir.join(format!("frame_{:06}.png", i));
            if fs::write(&file_path, bytes).is_ok() {
                timed_files.push((t, file_path));
            }
        }
    }

    if timed_files.is_empty() {
        let _ = fs::remove_dir_all(&dir);
        return None;
    }

    let mut concat = String::new();
    for i in 0..timed_files.len() {
        let (start_t, path) = (&timed_files[i].0, &timed_files[i].1);
        concat.push_str(&format!("file '{}'\n", ffconcat_escape_path(path)));
        let end_t = if i + 1 < timed_files.len() {
            timed_files[i + 1].0
        } else {
            duration_s
        };
        let dur = (end_t - *start_t).max(0.001);
        concat.push_str(&format!("duration {:.6}\n", dur));
    }
    if let Some((_, last)) = timed_files.last() {
        concat.push_str(&format!("file '{}'\n", ffconcat_escape_path(last)));
    }

    let concat_path = dir.join("overlay.ffconcat");
    if fs::write(&concat_path, concat).is_err() {
        let _ = fs::remove_dir_all(&dir);
        return None;
    }
    Some((concat_path, dir))
}

#[tauri::command]
fn pick_export_path(request: Option<PickExportPathRequest>) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new()
        .add_filter("MP4 video", &["mp4"])
        .set_file_name("teslacam-export.mp4");

    if let Some(raw) = request.and_then(|r| r.current_path) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let normalized = normalize_output_path(trimmed);
            let p = PathBuf::from(normalized);
            if let Some(parent) = p.parent() {
                if parent.exists() {
                    dialog = dialog.set_directory(parent);
                }
            }
            if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
                if !name.is_empty() {
                    dialog = dialog.set_file_name(name);
                }
            }
        }
    }

    Ok(dialog
        .save_file()
        .map(|p| normalize_output_path(&p.to_string_lossy())))
}

#[tauri::command]
async fn export_event_mp4(app: tauri::AppHandle, request: ExportRequest) -> Result<ExportResponse, String> {
    tauri::async_runtime::spawn_blocking(move || export_event_mp4_impl(app, request))
        .await
        .map_err(|e| format!("Export task join error: {}", e))?
}

fn run_ffmpeg_with_live_logs(
    app: &tauri::AppHandle,
    ffmpeg_bin: &str,
    args: &[String],
) -> Result<(bool, String, String), String> {
    let mut child = Command::new(ffmpeg_bin)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start ffmpeg: {}", e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app_for_logs = app.clone();

    let stdout_thread = std::thread::spawn(move || {
        let mut acc = String::new();
        if let Some(out) = stdout {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                if !line.is_empty() {
                    acc.push_str(&line);
                    acc.push('\n');
                }
            }
        }
        acc
    });

    let stderr_thread = std::thread::spawn(move || {
        let mut acc = String::new();
        if let Some(err) = stderr {
            let reader = BufReader::new(err);
            for line in reader.lines().map_while(Result::ok) {
                let text = line.trim();
                if text.is_empty() {
                    continue;
                }
                let _ = app_for_logs.emit("ffmpeg-log", text.to_string());
                acc.push_str(text);
                acc.push('\n');
            }
        }
        acc
    });

    let status = child
        .wait()
        .map_err(|e| format!("Failed waiting for ffmpeg process: {}", e))?;
    let stdout_text = stdout_thread
        .join()
        .map_err(|_| "Failed joining ffmpeg stdout reader thread".to_string())?;
    let stderr_text = stderr_thread
        .join()
        .map_err(|_| "Failed joining ffmpeg stderr reader thread".to_string())?;

    Ok((status.success(), stdout_text, stderr_text))
}

fn export_event_mp4_impl(app: tauri::AppHandle, request: ExportRequest) -> Result<ExportResponse, String> {
    let main = choose_main_path(&request).ok_or_else(|| "No video clips available for export".to_string())?;
    let main_duration_s = read_video_duration_seconds(&main).map(|v| v + 0.05);
    let mut telemetry_concat_path: Option<PathBuf> = None;
    let mut telemetry_temp_dir: Option<PathBuf> = None;
    if let Some(dur) = main_duration_s {
        let overlay_duration = request
            .overlay_duration_sec
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(dur);
        if let Some(frames) = request.telemetry_png_frames.as_ref() {
            if !frames.is_empty() {
                if let Some((concat_path, temp_dir)) =
                    write_telemetry_png_overlay_from_js_frames_temp(frames, overlay_duration)
                {
                    let _ = app.emit(
                        "ffmpeg-log",
                        format!(
                            "Telemetry overlay loaded from JS PNG frames at {}",
                            concat_path.display()
                        ),
                    );
                    telemetry_concat_path = Some(concat_path);
                    telemetry_temp_dir = Some(temp_dir);
                } else {
                    let _ = app.emit(
                        "ffmpeg-log",
                        "Telemetry overlay unavailable: failed writing temporary PNG overlay sequence.",
                    );
                }
            }
        }
    } else {
        let _ = app.emit(
            "ffmpeg-log",
            "Telemetry overlay unavailable: could not determine main clip duration.",
        );
    }
    let output_path = normalize_output_path(&request.output_path);
    if let Some(parent) = Path::new(&output_path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create export directory {}: {}", parent.display(), e))?;
        }
    }
    let temp_output_path = format!("{}.part.mp4", output_path);
    let _ = fs::remove_file(&temp_output_path);

    let mut previews = Vec::new();
    let order = ["left", "right", "back", "front"];
    for cam in order {
        if cam == request.main_camera {
            continue;
        }
        let p = match cam {
            "front" => request.clips.front.clone(),
            "back" => request.clips.back.clone(),
            "left" => request.clips.left.clone(),
            "right" => request.clips.right.clone(),
            _ => None,
        };
        if let Some(path) = p {
            if path != main {
                previews.push(path);
            }
        }
        if previews.len() == 3 {
            break;
        }
    }

    let mut filter = String::from(
        "[0:v]scale=1440:1080:force_original_aspect_ratio=decrease,pad=1440:1080:(ow-iw)/2:(oh-ih)/2[main];color=c=black:s=1920x1080[canvas];[canvas][main]overlay=0:0:shortest=1[base]",
    );

    for (i, _) in previews.iter().enumerate() {
        let idx = i + 1;
        filter.push_str(&format!(
            ";[{}:v]scale=-2:900:force_original_aspect_ratio=decrease,scale=480:360:force_original_aspect_ratio=decrease,pad=480:360:(ow-iw)/2:(oh-ih)/2[p{}]",
            idx, idx
        ));
    }

    let mut current = "base".to_string();
    if previews.is_empty() {
        filter.push_str(";[base]copy[outv]");
    } else {
        for (i, _) in previews.iter().enumerate() {
            let idx = i + 1;
            let y = i * 360;
            let next = if i == previews.len() - 1 {
                "outv".to_string()
            } else {
                format!("tmp{}", idx)
            };
            filter.push_str(&format!(
                ";[{}][p{}]overlay=1440:{}[{}]",
                current, idx, y, next
            ));
            current = next;
        }
    }
    filter.push_str(";[outv]fps=30[outvfps]");
    let overlay_input_index = if telemetry_concat_path.is_some() {
        Some(1 + previews.len())
    } else {
        None
    };
    let final_filter = with_telemetry_filter(&filter, overlay_input_index);

    let ffmpeg_bin = resolve_tool("ffmpeg");
    let mut codec_plan: Vec<String> = Vec::new();
    if let Some(codec) = working_gpu_encoder(&ffmpeg_bin) {
        codec_plan.push(codec);
    }
    codec_plan.push("libx264".to_string());

    let mut last_err = String::new();
    for codec in codec_plan {
        let args = build_export_ffmpeg_args(
            &main,
            &previews,
            &final_filter,
            &codec,
            &temp_output_path,
            main_duration_s,
            telemetry_concat_path.as_deref(),
        );
        let _ = app.emit("ffmpeg-log", format!("Starting ffmpeg export with encoder={}", codec));
        let (ok, stdout, stderr) = run_ffmpeg_with_live_logs(&app, &ffmpeg_bin, &args)?;

        if ok {
            let _ = fs::remove_file(&output_path);
            fs::rename(&temp_output_path, &output_path)
                .map_err(|e| format!("Failed to finalize export file {}: {}", output_path, e))?;
            if let Some(ref dir) = telemetry_temp_dir {
                let _ = fs::remove_dir_all(dir);
            }
            return Ok(ExportResponse {
                output_path: output_path.clone(),
                ffmpeg_stdout: format!(
                    "encoder={}\n{}",
                    codec,
                    stdout
                ),
            });
        }

        last_err = format!("ffmpeg failed using {}: {}", codec, stderr);
    }

    let _ = fs::remove_file(&temp_output_path);
    if let Some(dir) = telemetry_temp_dir {
        let _ = fs::remove_dir_all(dir);
    }
    Err(last_err)
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            if let (Some(window), Some(icon)) = (
                app.get_webview_window("main"),
                app.default_window_icon().cloned(),
            ) {
                let _ = window.set_icon(icon);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_teslacam,
            read_clip_metadata,
            pick_export_path,
            export_event_mp4
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
