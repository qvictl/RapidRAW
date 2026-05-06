//! Headless benchmark for RapidRAW image processing pipeline.
//!
//! Usage:
//! ```bash
//! cargo run --bin benchmark -- /path/to/raw.arw [iterations]
//! ```

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use image::GenericImageView;

use rapidraw_lib::{
    AppState, DecodedImageCache, GpuContext, RenderRequest,
    ThumbnailManager, ThumbnailProgressTracker,
    develop_raw_image, get_all_adjustments_from_json, process_and_get_dynamic_image_inner,
};

#[derive(Clone, Copy, Debug)]
enum TargetDevice {
    Cpu,
    AmdIntegrated,
    NvidiaDiscrete,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: {} <raw-file-path> [iterations]", args[0]);
        std::process::exit(1);
    }

    let raw_path = &args[1];
    let iterations: usize = args
        .get(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);

    println!("RapidRAW Processing Benchmark");
    println!("=============================");
    println!("File: {}", raw_path);
    println!("Iterations: {}", iterations);

    // Load and develop RAW
    println!("\n[1/3] Loading and developing RAW...");
    let file_bytes = std::fs::read(raw_path).expect("Failed to read raw file");
    let base_image = develop_raw_image(
        &file_bytes,
        false,       // fast_demosaic
        2.5,         // highlight_compression
        "srgb".to_string(), // linear_mode
        None,        // cancel_token
    )
    .expect("Failed to develop raw image");
    let (w, h) = base_image.dimensions();
    println!("    Resolution: {}x{}", w, h);

    // Build default adjustments (neutral)
    let adjustments = serde_json::json!({
        "exposure": 0.0,
        "contrast": 0.0,
        "highlights": 0.0,
        "shadows": 0.0,
        "whites": 0.0,
        "blacks": 0.0,
        "saturation": 0.0,
        "temperature": 0.0,
        "tint": 0.0,
        "vibrance": 0.0,
        "sharpness": 0.0,
        "lumaNoiseReduction": 0.0,
        "colorNoiseReduction": 0.0,
        "clarity": 0.0,
        "dehaze": 0.0,
        "structure": 0.0,
        "vignetteAmount": 0.0,
        "toneMapper": "basic",
    });
    let all_adjustments = get_all_adjustments_from_json(
        &adjustments,
        true,  // is_raw
        None,  // tonemapper_override
    );

    // Enumerate adapters
    println!("\n[2/3] Enumerating GPU adapters...");
    let instance = wgpu::Instance::new(
        &wgpu::InstanceDescriptor::from_env_or_default()
    );
    let adapters: Vec<wgpu::Adapter> =
        pollster::block_on(instance.enumerate_adapters(wgpu::Backends::all()));

    println!("    Found {} adapter(s):", adapters.len());
    for (i, adapter) in adapters.iter().enumerate() {
        let info = adapter.get_info();
        println!(
            "      [{}] {} | {:?} | vendor:{:#06x} device:{:#06x}",
            i, info.name, info.device_type, info.vendor, info.device
        );
    }

    // Define targets
    let targets = vec![
        ("CPU (lavapipe)", TargetDevice::Cpu),
        ("AMD iGPU", TargetDevice::AmdIntegrated),
        ("NVIDIA dGPU", TargetDevice::NvidiaDiscrete),
    ];

    println!("\n[3/3] Running benchmarks...\n");

    for (label, target) in targets {
        let adapter = find_adapter(&adapters, target);
        let Some(adapter) = adapter else {
            println!("--- {} ---", label);
            println!("    SKIPPED (adapter not found)\n");
            continue;
        };

        let info = adapter.get_info();
        println!("--- {} ({}) ---", label, info.name);

        let mut required_features = wgpu::Features::empty();
        if adapter
            .features()
            .contains(wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES)
        {
            required_features |= wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES;
        }

        let limits = adapter.limits();
        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("benchmark-device"),
                required_features,
                required_limits: limits.clone(),
                experimental_features: wgpu::ExperimentalFeatures::default(),
                memory_hints: wgpu::MemoryHints::Performance,
                trace: wgpu::Trace::Off,
            },
        ))
        .expect("Failed to request wgpu device");

        let context = GpuContext {
            device: Arc::new(device),
            queue: Arc::new(queue),
            limits,
            display: Arc::new(Mutex::new(None)),
        };

        let state = create_minimal_app_state();

        // Warm-up: process once to initialize GPU processor
        let warmup_request = RenderRequest {
            adjustments: all_adjustments.clone(),
            mask_bitmaps: &[],
            lut: None,
            roi: None,
        };
        let _ = process_and_get_dynamic_image_inner(
            &context,
            &state,
            &base_image,
            0,
            warmup_request,
            "benchmark-warmup",
            false,
            None,
        )
        .expect("Warm-up failed");

        // Determine iteration count per target
        let iters = match target {
            TargetDevice::Cpu => 1usize,
            _ => iterations,
        };

        // Benchmark iterations
        let mut times_ms = Vec::with_capacity(iters);
        for i in 0..iters {
            let req = RenderRequest {
                adjustments: all_adjustments.clone(),
                mask_bitmaps: &[],
                lut: None,
                roi: None,
            };
            let start = Instant::now();
            let result = process_and_get_dynamic_image_inner(
                &context,
                &state,
                &base_image,
                i as u64, // vary transform_hash to prevent cache reuse
                req,
                "benchmark",
                false,
                None,
            );
            let elapsed = start.elapsed();
            assert!(result.is_ok(), "Processing failed on iteration {}: {:?}", i, result.err());
            times_ms.push(elapsed.as_secs_f64() * 1000.0);
        }

        // Stats
        let total_ms: f64 = times_ms.iter().sum();
        let avg_ms = total_ms / iters as f64;
        let min_ms = times_ms.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_ms = times_ms.iter().cloned().fold(0.0_f64, f64::max);
        let fps = 1000.0 / avg_ms;

        println!("    Iterations : {}", iters);
        println!("    Total      : {:.2} ms", total_ms);
        println!("    Average    : {:.2} ms", avg_ms);
        println!("    Min        : {:.2} ms", min_ms);
        println!("    Max        : {:.2} ms", max_ms);
        println!("    FPS        : {:.2}", fps);
        println!();
    }

    println!("Benchmark complete.");
}

fn find_adapter(adapters: &[wgpu::Adapter], target: TargetDevice) -> Option<wgpu::Adapter> {
    // First pass: search in provided adapters
    for adapter in adapters {
        let info = adapter.get_info();
        match target {
            TargetDevice::Cpu => {
                if info.device_type == wgpu::DeviceType::Cpu {
                    return Some(adapter.clone());
                }
            }
            TargetDevice::AmdIntegrated => {
                if info.vendor == 0x1002
                    && info.device_type == wgpu::DeviceType::IntegratedGpu
                {
                    return Some(adapter.clone());
                }
                // Fallback: any AMD GPU if integrated not explicitly reported
                if info.vendor == 0x1002
                    && info.device_type == wgpu::DeviceType::DiscreteGpu
                {
                    return Some(adapter.clone());
                }
            }
            TargetDevice::NvidiaDiscrete => {
                if info.vendor == 0x10DE
                    && info.device_type == wgpu::DeviceType::DiscreteGpu
                {
                    return Some(adapter.clone());
                }
            }
        }
    }

    // Second pass for NVIDIA: try GL backend if Vulkan didn't expose it
    if let TargetDevice::NvidiaDiscrete = target {
        println!("    [NVIDIA not found via Vulkan, trying GL backend...]");
        let gl_instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::GL,
            ..Default::default()
        });
        let gl_adapters: Vec<wgpu::Adapter> =
            pollster::block_on(gl_instance.enumerate_adapters(wgpu::Backends::GL));
        for adapter in &gl_adapters {
            let info = adapter.get_info();
            if info.vendor == 0x10DE {
                println!("    [Found NVIDIA via GL: {} | {:?}]", info.name, info.device_type);
                return Some(adapter.clone());
            }
        }
    }

    None
}

fn create_minimal_app_state() -> AppState {
    AppState {
        window_setup_complete: AtomicBool::new(false),
        gpu_crash_flag_path: Mutex::new(None),
        original_image: Mutex::new(None),
        cached_preview: Mutex::new(None),
        gpu_context: Mutex::new(None),
        gpu_image_cache: Mutex::new(None),
        gpu_processor: Mutex::new(None),
        ai_state: Mutex::new(None),
        ai_init_lock: tokio::sync::Mutex::new(()),
        export_task_handle: Mutex::new(None),
        hdr_result: Arc::new(Mutex::new(None)),
        panorama_result: Arc::new(Mutex::new(None)),
        denoise_result: Arc::new(Mutex::new(None)),
        indexing_task_handle: Mutex::new(None),
        lut_cache: Mutex::new(HashMap::new()),
        initial_file_path: Mutex::new(None),
        thumbnail_cancellation_token: Arc::new(AtomicBool::new(false)),
        thumbnail_progress: Mutex::new(ThumbnailProgressTracker {
            total: 0,
            completed: 0,
        }),
        preview_worker_tx: Mutex::new(None),
        analytics_worker_tx: Mutex::new(None),
        mask_cache: Mutex::new(HashMap::new()),
        patch_cache: Mutex::new(HashMap::new()),
        geometry_cache: Mutex::new(HashMap::new()),
        thumbnail_geometry_cache: Mutex::new(HashMap::new()),
        lens_db: Mutex::new(None),
        load_image_generation: Arc::new(AtomicUsize::new(0)),
        full_warped_cache: Mutex::new(None),
        full_transformed_cache: Mutex::new(None),
        decoded_image_cache: Mutex::new(DecodedImageCache::new(5)),
        thumbnail_manager: ThumbnailManager::new(),
    }
}
