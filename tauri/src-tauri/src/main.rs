// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio_capture;
mod audio_output;

use std::sync::Mutex;
use tauri::{command, Emitter, Listener, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::mpsc;

const LEGACY_PORT: u16 = 8000;
const SERVER_PORT: u16 = 17493;

struct ServerState {
    child: Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
    server_pid: Mutex<Option<u32>>,
    job_handle: Mutex<Option<isize>>,
    keep_running_on_close: Mutex<bool>,
}

#[command]
async fn start_server(
    app: tauri::AppHandle,
    state: State<'_, ServerState>,
    remote: Option<bool>,
) -> Result<String, String> {
    // Check if server is already running (managed by this app instance)
    if state.child.lock().unwrap().is_some() {
        return Ok(format!("http://127.0.0.1:{}", SERVER_PORT));
    }

    // Check if a vibetube server is already running on our port (from previous session with keep_running=true)
    #[cfg(unix)]
    {
        use std::process::Command;
        if let Ok(output) = Command::new("lsof")
            .args(["-i", &format!(":{}", SERVER_PORT), "-sTCP:LISTEN"])
            .output()
        {
            let output_str = String::from_utf8_lossy(&output.stdout);
            for line in output_str.lines().skip(1) {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    let command = parts[0];
                    let pid_str = parts[1];
                    if command.contains("vibetube") {
                        if let Ok(pid) = pid_str.parse::<u32>() {
                            println!(
                                "Found existing vibetube-server on port {} (PID: {}), reusing it",
                                SERVER_PORT, pid
                            );
                            track_server_process(&state, pid);
                            return Ok(format!("http://127.0.0.1:{}", SERVER_PORT));
                        }
                    }
                }
            }
        }
    }

    #[cfg(windows)]
    {
        use std::process::Command;
        if let Ok(output) = Command::new("netstat").args(["-ano"]).output() {
            let output_str = String::from_utf8_lossy(&output.stdout);
            for line in output_str.lines() {
                if line.contains(&format!(":{}", SERVER_PORT)) && line.contains("LISTENING") {
                    if let Some(pid_str) = line.split_whitespace().last() {
                        if let Ok(pid) = pid_str.parse::<u32>() {
                            if let Ok(tasklist_output) = Command::new("tasklist")
                                .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
                                .output()
                            {
                                let tasklist_str = String::from_utf8_lossy(&tasklist_output.stdout);
                                if tasklist_str.to_lowercase().contains("vibetube") {
                                    println!("Found existing vibetube-server on port {} (PID: {}), reusing it", SERVER_PORT, pid);
                                    track_server_process(&state, pid);
                                    return Ok(format!("http://127.0.0.1:{}", SERVER_PORT));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Kill any orphaned vibetube-server from previous session on legacy port 8000
    // This handles upgrades from older versions that used a fixed port
    #[cfg(unix)]
    {
        use std::process::Command;
        // Find processes listening on legacy port 8000 with their command names
        if let Ok(output) = Command::new("lsof")
            .args(["-i", &format!(":{}", LEGACY_PORT), "-sTCP:LISTEN"])
            .output()
        {
            let output_str = String::from_utf8_lossy(&output.stdout);
            for line in output_str.lines().skip(1) {
                // Skip header line
                // lsof output format: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    let command = parts[0];
                    let pid_str = parts[1];

                    // Only kill if it's a vibetube-server process
                    if command.contains("vibetube") {
                        if let Ok(pid) = pid_str.parse::<i32>() {
                            println!("Found orphaned vibetube-server on legacy port {} (PID: {}, CMD: {}), killing it...", LEGACY_PORT, pid, command);
                            // Kill the process group
                            let _ = Command::new("kill")
                                .args(["-9", "--", &format!("-{}", pid)])
                                .output();
                            let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
                        }
                    } else {
                        println!("Legacy port {} is in use by non-vibetube process: {} (PID: {}), not killing", LEGACY_PORT, command, pid_str);
                    }
                }
            }
        }
    }

    #[cfg(windows)]
    {
        use std::process::Command;
        // On Windows, find PIDs on legacy port 8000, then check their names
        if let Ok(output) = Command::new("netstat").args(["-ano"]).output() {
            let output_str = String::from_utf8_lossy(&output.stdout);
            for line in output_str.lines() {
                if line.contains(&format!(":{}", LEGACY_PORT)) && line.contains("LISTENING") {
                    if let Some(pid_str) = line.split_whitespace().last() {
                        if let Ok(pid) = pid_str.parse::<u32>() {
                            // Get process name for this PID
                            if let Ok(tasklist_output) = Command::new("tasklist")
                                .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
                                .output()
                            {
                                let tasklist_str = String::from_utf8_lossy(&tasklist_output.stdout);
                                if tasklist_str.to_lowercase().contains("vibetube") {
                                    println!("Found orphaned vibetube-server on legacy port {} (PID: {}), killing it...", LEGACY_PORT, pid);
                                    let _ = Command::new("taskkill")
                                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                                        .output();
                                } else {
                                    println!("Legacy port {} is in use by non-vibetube process (PID: {}), not killing", LEGACY_PORT, pid);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Brief wait for port to be released
    std::thread::sleep(std::time::Duration::from_millis(200));

    // Get app data directory
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    // Ensure data directory exists
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("Failed to create data dir: {}", e))?;

    println!("=================================================================");
    println!("Starting vibetube-server sidecar");
    println!("Data directory: {:?}", data_dir);
    println!("Remote mode: {}", remote.unwrap_or(false));

    let sidecar_result = app.shell().sidecar("vibetube-server");

    let mut sidecar = match sidecar_result {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Failed to get sidecar: {}", e);

            // In dev mode, check if the server is already running (started manually)
            #[cfg(debug_assertions)]
            {
                eprintln!(
                    "Dev mode: Checking if server is already running on port {}...",
                    SERVER_PORT
                );

                // Try to connect to the server port
                use std::net::TcpStream;
                if TcpStream::connect_timeout(
                    &format!("127.0.0.1:{}", SERVER_PORT).parse().unwrap(),
                    std::time::Duration::from_secs(1),
                )
                .is_ok()
                {
                    println!("Found server already running on port {}", SERVER_PORT);
                    return Ok(format!("http://127.0.0.1:{}", SERVER_PORT));
                }

                eprintln!("");
                eprintln!("=================================================================");
                eprintln!("DEV MODE: No server found on port {}", SERVER_PORT);
                eprintln!("");
                eprintln!("Start the Python server in a separate terminal:");
                eprintln!("  bun run dev:server");
                eprintln!("=================================================================");
                eprintln!("");
            }

            return Err(format!("Failed to start server. In dev mode, run 'bun run dev:server' in a separate terminal."));
        }
    };

    println!("Sidecar command created successfully");

    // Pass data directory and port to Python server
    sidecar = sidecar.args([
        "--data-dir",
        data_dir
            .to_str()
            .ok_or_else(|| "Invalid data dir path".to_string())?,
        "--port",
        &SERVER_PORT.to_string(),
    ]);

    if remote.unwrap_or(false) {
        sidecar = sidecar.args(["--host", "0.0.0.0"]);
    }

    println!("Spawning server process...");
    let spawn_result = sidecar.spawn();

    let (mut rx, child) = match spawn_result {
        Ok(result) => result,
        Err(e) => {
            eprintln!("Failed to spawn server process: {}", e);

            // In dev mode, check if a manually-started server is available
            #[cfg(debug_assertions)]
            {
                use std::net::TcpStream;
                if TcpStream::connect_timeout(
                    &format!("127.0.0.1:{}", SERVER_PORT).parse().unwrap(),
                    std::time::Duration::from_secs(1),
                )
                .is_ok()
                {
                    println!("Found manually-started server on port {}", SERVER_PORT);
                    return Ok(format!("http://127.0.0.1:{}", SERVER_PORT));
                }

                eprintln!("");
                eprintln!("=================================================================");
                eprintln!("DEV MODE: Server binary failed to start");
                eprintln!("");
                eprintln!("Start the Python server in a separate terminal:");
                eprintln!("  bun run dev:server");
                eprintln!("=================================================================");
                eprintln!("");
                return Err("Dev mode: Start server manually with 'bun run dev:server'".to_string());
            }

            #[cfg(not(debug_assertions))]
            {
                eprintln!("This could be due to:");
                eprintln!("  - Missing or corrupted binary");
                eprintln!("  - Missing execute permissions");
                eprintln!("  - Code signing issues on macOS");
                eprintln!("  - Missing dependencies");
                return Err(format!("Failed to spawn: {}", e));
            }
        }
    };

    println!("Server process spawned, waiting for ready signal...");
    println!("=================================================================");

    // Store child process and PID
    let process_pid = child.pid();
    *state.child.lock().unwrap() = Some(child);
    track_server_process(&state, process_pid);

    // Wait for server to be ready by listening for startup log
    // PyInstaller bundles can be slow on first import, especially torch/transformers
    let timeout = tokio::time::Duration::from_secs(120);
    let start_time = tokio::time::Instant::now();
    let mut error_output = Vec::new();

    loop {
        if start_time.elapsed() > timeout {
            eprintln!("Server startup timeout after 120 seconds");
            if !error_output.is_empty() {
                eprintln!("Collected error output:");
                for line in &error_output {
                    eprintln!("  {}", line);
                }
            }

            // In dev mode, check if a manual server came up during the wait
            #[cfg(debug_assertions)]
            {
                use std::net::TcpStream;
                if TcpStream::connect_timeout(
                    &format!("127.0.0.1:{}", SERVER_PORT).parse().unwrap(),
                    std::time::Duration::from_secs(1),
                )
                .is_ok()
                {
                    // Kill the placeholder process
                    let _ = state.child.lock().unwrap().take();
                    println!("Found manually-started server on port {}", SERVER_PORT);
                    return Ok(format!("http://127.0.0.1:{}", SERVER_PORT));
                }
            }

            return Err("Server startup timeout - check Console.app for detailed logs".to_string());
        }

        match tokio::time::timeout(tokio::time::Duration::from_millis(100), rx.recv()).await {
            Ok(Some(event)) => {
                match event {
                    tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                        let line_str = String::from_utf8_lossy(&line);
                        println!("Server output: {}", line_str);

                        if line_str.contains("Uvicorn running")
                            || line_str.contains("Application startup complete")
                        {
                            println!("Server is ready!");
                            break;
                        }
                    }
                    tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                        let line_str = String::from_utf8_lossy(&line).to_string();
                        eprintln!("Server: {}", line_str);

                        // Collect error lines for debugging
                        if line_str.contains("ERROR")
                            || line_str.contains("Error")
                            || line_str.contains("Failed")
                        {
                            error_output.push(line_str.clone());
                        }

                        // Uvicorn logs to stderr, so check there too
                        if line_str.contains("Uvicorn running")
                            || line_str.contains("Application startup complete")
                        {
                            println!("Server is ready!");
                            break;
                        }
                    }
                    _ => {}
                }
            }
            Ok(None) => {
                // In dev mode, this is expected when using the placeholder binary
                #[cfg(debug_assertions)]
                {
                    use std::net::TcpStream;
                    eprintln!("Server process ended (dev mode placeholder detected)");

                    // Check if a manually-started server is available
                    if TcpStream::connect_timeout(
                        &format!("127.0.0.1:{}", SERVER_PORT).parse().unwrap(),
                        std::time::Duration::from_secs(1),
                    )
                    .is_ok()
                    {
                        // Clean up state
                        let _ = state.child.lock().unwrap().take();
                        let _ = state.server_pid.lock().unwrap().take();
                        println!("Found manually-started server on port {}", SERVER_PORT);
                        return Ok(format!("http://127.0.0.1:{}", SERVER_PORT));
                    }

                    eprintln!("");
                    eprintln!("=================================================================");
                    eprintln!("DEV MODE: No bundled server binary available");
                    eprintln!("");
                    eprintln!("Start the Python server in a separate terminal:");
                    eprintln!("  bun run dev:server");
                    eprintln!("=================================================================");
                    eprintln!("");
                    return Err(
                        "Dev mode: Start server manually with 'bun run dev:server'".to_string()
                    );
                }

                #[cfg(not(debug_assertions))]
                {
                    eprintln!("Server process ended unexpectedly during startup!");
                    eprintln!("The server binary may have crashed or exited with an error.");
                    eprintln!("Check Console.app logs for more details (search for 'vibetube')");
                    return Err("Server process ended unexpectedly".to_string());
                }
            }
            Err(_) => {
                // Timeout on this recv, continue loop
                continue;
            }
        }
    }

    // Spawn task to continue reading output
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                    println!("Server: {}", String::from_utf8_lossy(&line));
                }
                tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                    eprintln!("Server error: {}", String::from_utf8_lossy(&line));
                }
                _ => {}
            }
        }
    });

    Ok(format!("http://127.0.0.1:{}", SERVER_PORT))
}

/// Check if a Windows process is still running
#[cfg(windows)]
fn is_process_running(pid: u32) -> bool {
    use std::process::Command;
    if let Ok(output) = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
        .output()
    {
        // If process exists, tasklist returns it in output
        let output_str = String::from_utf8_lossy(&output.stdout);
        return !output_str.trim().is_empty() && output_str.contains(&pid.to_string());
    }
    false
}

#[cfg(windows)]
fn close_windows_job_handle(raw_handle: isize) {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};

    unsafe {
        let _ = CloseHandle(HANDLE(raw_handle as *mut core::ffi::c_void));
    }
}

#[cfg(windows)]
fn create_windows_job_for_pid(pid: u32) -> Result<isize, String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    unsafe {
        let job = CreateJobObjectW(None, None)
            .map_err(|e| format!("CreateJobObjectW failed for PID {}: {}", pid, e))?;

        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        if let Err(error) = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) {
            let _ = CloseHandle(job);
            return Err(format!(
                "SetInformationJobObject failed for PID {}: {}",
                pid, error
            ));
        }

        let process = OpenProcess(
            PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            pid,
        )
        .map_err(|e| {
            let _ = CloseHandle(job);
            format!("OpenProcess failed for PID {}: {}", pid, e)
        })?;

        if let Err(error) = AssignProcessToJobObject(job, process) {
            let _ = CloseHandle(process);
            let _ = CloseHandle(job);
            return Err(format!(
                "AssignProcessToJobObject failed for PID {}: {}",
                pid, error
            ));
        }

        let _ = CloseHandle(process);
        Ok(job.0 as isize)
    }
}

#[cfg(windows)]
fn replace_windows_job_handle(state: &ServerState, new_handle: Option<isize>) {
    let mut job_handle = state.job_handle.lock().unwrap();
    if let Some(existing_handle) = job_handle.take() {
        close_windows_job_handle(existing_handle);
    }
    *job_handle = new_handle;
}

fn track_server_process(state: &ServerState, pid: u32) {
    *state.server_pid.lock().unwrap() = Some(pid);

    #[cfg(windows)]
    {
        match create_windows_job_for_pid(pid) {
            Ok(job_handle) => {
                println!(
                    "Assigned vibetube-server PID {} to Windows job object {}",
                    pid, job_handle
                );
                replace_windows_job_handle(state, Some(job_handle));
            }
            Err(error) => {
                eprintln!(
                    "Failed to assign vibetube-server PID {} to job object: {}",
                    pid, error
                );
                replace_windows_job_handle(state, None);
            }
        }
    }
}

#[cfg(windows)]
fn list_windows_process_ids_by_image(image_name: &str) -> Vec<u32> {
    use std::process::Command;
    let Ok(output) = Command::new("tasklist")
        .args([
            "/FI",
            &format!("IMAGENAME eq {}", image_name),
            "/FO",
            "CSV",
            "/NH",
        ])
        .output()
    else {
        return Vec::new();
    };

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with("INFO:") {
                return None;
            }

            let columns: Vec<&str> = line.split("\",\"").collect();
            if columns.len() < 2 {
                return None;
            }

            columns[1].trim_matches('"').parse::<u32>().ok()
        })
        .collect()
}

#[cfg(windows)]
fn find_windows_listening_pids(port: u16) -> Vec<u32> {
    use std::process::Command;
    let Ok(output) = Command::new("netstat").args(["-ano"]).output() else {
        return Vec::new();
    };

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| line.contains(&format!(":{}", port)) && line.contains("LISTENING"))
        .filter_map(|line| line.split_whitespace().last()?.parse::<u32>().ok())
        .collect()
}

#[cfg(windows)]
fn is_vibetube_server_running() -> bool {
    !find_windows_listening_pids(SERVER_PORT).is_empty()
        || !list_windows_process_ids_by_image("vibetube-server.exe").is_empty()
}

/// Kill entire Windows process tree by enumerating children
#[cfg(windows)]
fn kill_windows_process_tree(parent_pid: u32) -> Result<(), String> {
    use std::process::Command;
    let output = Command::new("taskkill")
        .args(["/PID", &parent_pid.to_string(), "/T", "/F"])
        .output()
        .map_err(|e| format!("Failed to execute taskkill: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "taskkill failed for PID {}: {}",
            parent_pid,
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

#[cfg(windows)]
fn wait_for_windows_server_exit(tracked_pid: Option<u32>, timeout_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);

    loop {
        let tracked_running = tracked_pid.is_some_and(is_process_running);
        let listener_pids = find_windows_listening_pids(SERVER_PORT);
        let image_pids = list_windows_process_ids_by_image("vibetube-server.exe");

        if !tracked_running && listener_pids.is_empty() && image_pids.is_empty() {
            return true;
        }

        if std::time::Instant::now() >= deadline {
            println!(
                "Windows shutdown wait timed out. tracked_pid={:?}, listener_pids={:?}, image_pids={:?}",
                tracked_pid, listener_pids, image_pids
            );
            return false;
        }

        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

#[cfg(windows)]
fn shutdown_windows_server_processes(tracked_pid: Option<u32>) -> Result<(), String> {
    use std::process::Command;

    println!(
        "Windows shutdown starting. tracked_pid={:?}, listener_pids={:?}, image_pids={:?}",
        tracked_pid,
        find_windows_listening_pids(SERVER_PORT),
        list_windows_process_ids_by_image("vibetube-server.exe")
    );

    println!("Attempting graceful shutdown via HTTP...");
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|e| format!("Failed to create shutdown HTTP client: {}", e))?;

    let shutdown_result = client
        .post(&format!("http://127.0.0.1:{}/shutdown", SERVER_PORT))
        .send();

    if shutdown_result.is_ok() {
        println!("HTTP shutdown sent, waiting for graceful exit...");
        if wait_for_windows_server_exit(tracked_pid, 3000) {
            println!("Server exited gracefully");
            return Ok(());
        }
        println!("Graceful shutdown timed out, forcing kill...");
    } else {
        println!("HTTP shutdown failed, forcing kill...");
    }

    if let Some(pid) = tracked_pid {
        println!("Killing tracked process tree for PID {}...", pid);
        if let Err(error) = kill_windows_process_tree(pid) {
            eprintln!("Failed to kill tracked PID {}: {}", pid, error);
        }
    } else {
        println!("No tracked PID available for process-tree kill");
    }

    for pid in find_windows_listening_pids(SERVER_PORT) {
        if Some(pid) == tracked_pid {
            continue;
        }

        println!("Killing listener process tree for PID {}...", pid);
        if let Err(error) = kill_windows_process_tree(pid) {
            eprintln!("Failed to kill listener PID {}: {}", pid, error);
        }
    }

    if wait_for_windows_server_exit(tracked_pid, 1500) {
        println!("Server stopped after process-tree kill");
        return Ok(());
    }

    let remaining_image_pids = list_windows_process_ids_by_image("vibetube-server.exe");
    if !remaining_image_pids.is_empty() || !find_windows_listening_pids(SERVER_PORT).is_empty() {
        println!(
            "Killing remaining vibetube-server.exe processes by image name: {:?}",
            remaining_image_pids
        );
        let output = Command::new("taskkill")
            .args(["/IM", "vibetube-server.exe", "/T", "/F"])
            .output()
            .map_err(|e| format!("Failed to execute image-name taskkill: {}", e))?;

        if !output.status.success() {
            eprintln!(
                "Image-name taskkill returned non-zero exit code: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    if wait_for_windows_server_exit(tracked_pid, 1500) {
        println!("Server stopped after image-name cleanup");
        return Ok(());
    }

    Err(format!(
        "Failed to fully stop vibetube-server. Remaining listener_pids={:?}, image_pids={:?}",
        find_windows_listening_pids(SERVER_PORT),
        list_windows_process_ids_by_image("vibetube-server.exe")
    ))
}

fn clear_server_state(state: &ServerState) {
    *state.server_pid.lock().unwrap() = None;
    *state.child.lock().unwrap() = None;

    #[cfg(windows)]
    replace_windows_job_handle(state, None);
}

fn shutdown_server_processes(state: &ServerState) -> Result<(), String> {
    let pid = *state.server_pid.lock().unwrap();

    #[cfg(unix)]
    {
        if let Some(pid) = pid {
            println!("Killing server process group with PID: {}", pid);
            use std::process::Command;
            let _ = Command::new("kill")
                .args(["-TERM", "--", &format!("-{}", pid)])
                .output();

            std::thread::sleep(std::time::Duration::from_millis(100));

            let _ = Command::new("kill")
                .args(["-9", "--", &format!("-{}", pid)])
                .output();
            let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();

            println!("Server process group kill completed");
        } else {
            println!("No server PID found (already stopped or never started)");
        }
    }

    #[cfg(windows)]
    {
        if pid.is_some() || is_vibetube_server_running() {
            shutdown_windows_server_processes(pid)?;
        } else {
            println!("No tracked or running vibetube-server found");
        }
    }

    clear_server_state(state);
    Ok(())
}

#[command]
async fn stop_server(state: State<'_, ServerState>) -> Result<(), String> {
    shutdown_server_processes(&state)
}

#[command]
fn set_keep_server_running(state: State<'_, ServerState>, keep_running: bool) {
    *state.keep_running_on_close.lock().unwrap() = keep_running;
}

#[command]
fn destroy_window_by_label(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let Some(window) = app.get_webview_window(&label) else {
        return Ok(());
    };

    window.destroy().map_err(|error| error.to_string())
}

#[command]
async fn start_system_audio_capture(
    state: State<'_, audio_capture::AudioCaptureState>,
    max_duration_secs: u32,
) -> Result<(), String> {
    audio_capture::start_capture(&state, max_duration_secs).await
}

#[command]
async fn stop_system_audio_capture(
    state: State<'_, audio_capture::AudioCaptureState>,
) -> Result<String, String> {
    audio_capture::stop_capture(&state).await
}

#[command]
fn is_system_audio_supported() -> bool {
    audio_capture::is_supported()
}

#[command]
fn list_audio_output_devices(
    state: State<'_, audio_output::AudioOutputState>,
) -> Result<Vec<audio_output::AudioOutputDevice>, String> {
    state.list_output_devices()
}

#[command]
async fn play_audio_to_devices(
    state: State<'_, audio_output::AudioOutputState>,
    audio_data: Vec<u8>,
    device_ids: Vec<String>,
) -> Result<(), String> {
    state.play_audio_to_devices(audio_data, device_ids).await
}

#[command]
fn stop_audio_playback(state: State<'_, audio_output::AudioOutputState>) -> Result<(), String> {
    state.stop_all_playback()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(ServerState {
            child: Mutex::new(None),
            server_pid: Mutex::new(None),
            job_handle: Mutex::new(None),
            keep_running_on_close: Mutex::new(false),
        })
        .manage(audio_capture::AudioCaptureState::new())
        .manage(audio_output::AudioOutputState::new())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }

            // Hide title bar icon on Windows
            #[cfg(windows)]
            {
                use windows::Win32::Foundation::HWND;
                use windows::Win32::UI::WindowsAndMessaging::{
                    SetClassLongPtrW, GCLP_HICON, GCLP_HICONSM,
                };

                if let Some((_, window)) = app.webview_windows().iter().next() {
                    if let Ok(hwnd) = window.hwnd() {
                        let hwnd = HWND(hwnd.0);
                        unsafe {
                            // Set both small and regular icons to NULL to hide the title bar icon
                            SetClassLongPtrW(hwnd, GCLP_HICON, 0);
                            SetClassLongPtrW(hwnd, GCLP_HICONSM, 0);
                        }
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_server,
            stop_server,
            set_keep_server_running,
            destroy_window_by_label,
            start_system_audio_capture,
            stop_system_audio_capture,
            is_system_audio_supported,
            list_audio_output_devices,
            play_audio_to_devices,
            stop_audio_playback
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    window.destroy().ok();
                    return;
                }

                // Prevent automatic close
                api.prevent_close();

                // Set up listener for frontend response
                let app_handle = window.app_handle();
                let window_for_close = window.clone();
                let (tx, mut rx) = mpsc::unbounded_channel::<()>();

                // Listen for response from frontend using window's listen method
                let listener_id = window.listen("window-close-allowed", move |_| {
                    // Frontend has checked setting and stopped server if needed
                    // Signal that we can close
                    let _ = tx.send(());
                });

                // Emit event to frontend to check setting and stop server if needed
                if let Err(e) = app_handle.emit("window-close-requested", ()) {
                    eprintln!("Failed to emit window-close-requested event: {}", e);
                    window.unlisten(listener_id);
                    // If event emission fails, allow close anyway
                    window.destroy().ok();
                    return;
                }

                // Wait for frontend response or timeout
                tokio::spawn(async move {
                    tokio::select! {
                        _ = rx.recv() => {
                            // Frontend responded, close window
                            window_for_close.destroy().ok();
                        }
                        _ = tokio::time::sleep(tokio::time::Duration::from_secs(5)) => {
                            // Timeout - close anyway
                            eprintln!("Window close timeout, closing anyway");
                            window_for_close.destroy().ok();
                        }
                    }
                    // Clean up listener
                    window_for_close.unlisten(listener_id);
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match &event {
                RunEvent::Exit => {
                    println!("=================================================================");
                    println!("RunEvent::Exit received - checking server cleanup");
                    let state = app.state::<ServerState>();
                    let keep_running = *state.keep_running_on_close.lock().unwrap();
                    println!("keep_running_on_close = {}", keep_running);

                    if !keep_running {
                        if let Err(error) = shutdown_server_processes(&state) {
                            eprintln!("Failed to stop server during app exit: {}", error);
                        }
                    } else {
                        println!("Keeping server running per user setting");
                    }
                    println!("=================================================================");
                }
                RunEvent::ExitRequested { api, .. } => {
                    println!("RunEvent::ExitRequested received");
                    // Don't prevent exit, just log it
                    let _ = api;
                }
                _ => {}
            }
        });
}

fn main() {
    run();
}
