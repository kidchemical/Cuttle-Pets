use std::ptr;
use std::sync::Mutex;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::NSString;
use tauri::{AppHandle, Emitter};

struct SpeechSession {
    engine: Retained<AnyObject>,
    _task: Retained<AnyObject>,
    request: Retained<AnyObject>,
}

// SAFETY: ObjC objects are reference-counted and thread-safe for our usage pattern.
// The SpeechSession is only accessed behind a Mutex.
unsafe impl Send for SpeechSession {}

static SESSION: Mutex<Option<SpeechSession>> = Mutex::new(None);

/// Take ownership of a +1 raw ObjC pointer (from alloc/init/new/copy).
unsafe fn owned(ptr: *mut AnyObject) -> Result<Retained<AnyObject>, String> {
    Retained::from_raw(ptr).ok_or_else(|| "ObjC returned nil".into())
}

/// Retain a +0 raw ObjC pointer (from regular method calls).
unsafe fn retained(ptr: *mut AnyObject) -> Result<Retained<AnyObject>, String> {
    Retained::retain(ptr).ok_or_else(|| "ObjC returned nil".into())
}

pub fn start(app: AppHandle) -> Result<(), String> {
    let mut guard = SESSION.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("Already recording".into());
    }

    unsafe {
        // --- Create SFSpeechRecognizer with zh-CN locale ---
        let locale_id = NSString::from_str("zh-CN");
        let ptr: *mut AnyObject = msg_send![class!(NSLocale), alloc];
        let ptr: *mut AnyObject = msg_send![ptr, initWithLocaleIdentifier: &*locale_id];
        let locale = owned(ptr)?;

        let ptr: *mut AnyObject = msg_send![class!(SFSpeechRecognizer), alloc];
        let ptr: *mut AnyObject = msg_send![ptr, initWithLocale: &*locale];
        let recognizer = owned(ptr)?;

        let available: bool = msg_send![&*recognizer, isAvailable];
        if !available {
            return Err("Speech recognizer is not available".into());
        }

        // --- Create SFSpeechAudioBufferRecognitionRequest ---
        let ptr: *mut AnyObject = msg_send![class!(SFSpeechAudioBufferRecognitionRequest), new];
        let request = owned(ptr)?;
        let _: () = msg_send![&*request, setShouldReportPartialResults: true];

        // --- Create AVAudioEngine ---
        let ptr: *mut AnyObject = msg_send![class!(AVAudioEngine), new];
        let engine = owned(ptr)?;

        // --- Get input node & recording format ---
        let input_node: *mut AnyObject = msg_send![&*engine, inputNode];
        let bus: usize = 0;
        let format_ptr: *mut AnyObject = msg_send![input_node, outputFormatForBus: bus];
        let format = retained(format_ptr)?;

        // --- Install tap on input node to feed audio to request ---
        let request_for_tap = request.clone();
        let tap_block = RcBlock::new(
            move |buffer: *mut AnyObject, _when: *mut AnyObject| {
                if !buffer.is_null() {
                    let _: () = msg_send![&*request_for_tap, appendAudioPCMBuffer: buffer];
                }
            },
        );

        let buf_size: u32 = 1024;
        let _: () = msg_send![
            input_node,
            installTapOnBus: bus,
            bufferSize: buf_size,
            format: &*format,
            block: &*tap_block
        ];

        // --- Result handler block ---
        let handler = RcBlock::new(
            move |result: *mut AnyObject, error: *mut AnyObject| {
                if !result.is_null() {
                    let best: *mut AnyObject = msg_send![result, bestTranscription];
                    let formatted: *mut NSString = msg_send![best, formattedString];
                    let is_final: bool = msg_send![result, isFinal];
                    let text = (*formatted).to_string();

                    let _ = app.emit(
                        "speech-result",
                        serde_json::json!({
                            "text": text,
                            "isFinal": is_final,
                        }),
                    );
                }
                if !error.is_null() && result.is_null() {
                    let desc: *mut NSString = msg_send![error, localizedDescription];
                    eprintln!("[speech] recognition error: {}", *desc);
                }
            },
        );

        // --- Start recognition task ---
        let ptr: *mut AnyObject = msg_send![
            &*recognizer,
            recognitionTaskWithRequest: &*request,
            resultHandler: &*handler
        ];
        let task = retained(ptr)?;

        // --- Start audio engine ---
        let _: () = msg_send![&*engine, prepare];
        let mut err_ptr: *mut AnyObject = ptr::null_mut();
        let ok: bool = msg_send![&*engine, startAndReturnError: &mut err_ptr];
        if !ok {
            // Cleanup on failure
            let _: () = msg_send![&*task, cancel];
            let _: () = msg_send![input_node, removeTapOnBus: bus];
            if !err_ptr.is_null() {
                let desc: *mut NSString = msg_send![err_ptr, localizedDescription];
                return Err(format!("Failed to start audio engine: {}", *desc));
            }
            return Err("Failed to start audio engine".into());
        }

        *guard = Some(SpeechSession {
            engine,
            _task: task,
            request,
        });
    }

    Ok(())
}

pub fn stop() -> Result<(), String> {
    let mut guard = SESSION.lock().map_err(|e| e.to_string())?;
    if let Some(session) = guard.take() {
        unsafe {
            // Stop audio engine
            let _: () = msg_send![&*session.engine, stop];

            // Remove tap from input node
            let input_node: *mut AnyObject = msg_send![&*session.engine, inputNode];
            let bus: usize = 0;
            let _: () = msg_send![input_node, removeTapOnBus: bus];

            // End the audio request (signals no more audio will be appended)
            let _: () = msg_send![&*session.request, endAudio];
        }
    }
    Ok(())
}
