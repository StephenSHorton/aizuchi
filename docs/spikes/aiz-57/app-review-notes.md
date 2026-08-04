# App Review framing — Aizuchi iOS (background-audio entitlement)

Apple's review team flags `UIBackgroundModes: [audio]` aggressively. Most rejections cite [App Review Guideline 2.5.4](https://developer.apple.com/app-store/review/guidelines/#2.5.4): the audio background mode is "intended for apps that provide audible content to the user while in the background, such as music players." Reviewers default to assuming the developer wants the entitlement to spy on users.

Aizuchi is a transcription app — it does *not* play audio in the background — but it does need to *record* audio while the screen is locked, because users hold 30-60 minute meetings and don't want to keep their phone unlocked the entire time. This document is the framing for the App Store description, the privacy explanation, and the reviewer-notes field.

---

## Privacy purpose string (Info.plist `NSMicrophoneUsageDescription`)

> Aizuchi captures your meeting audio to transcribe it into a live mind-map. Audio stays on your device — nothing is sent to a server.

Why this works:
- Names the feature ("transcribe", "mind-map") so the user knows what they're consenting to.
- Says "stays on your device" — this is true (whisper.cpp runs locally) and pre-empts the privacy-conscious reviewer.
- Short. Apple's HIG explicitly discourages long purpose strings.

---

## App Store description — short paragraph to include

> Aizuchi turns the conversations you're in into a live mind-map. Capture audio with one tap, watch ideas branch out as people speak, and keep the canvas with you after the meeting ends. All transcription happens **on your device** — your meeting audio never leaves your phone.
>
> Aizuchi keeps recording while your screen is locked, so you can put your phone in your bag during a coffee chat or a long workshop. Recording stops the moment you tap End Meeting or close the app.

The two italicized sentences pre-empt the two reviewer concerns: (1) why does it need background audio? (because users put phones away during meetings) and (2) where does the audio go? (nowhere — on-device).

---

## Notes for the reviewer (App Store Connect "Notes" field)

```
Aizuchi is an on-device transcription tool. The app captures meeting
audio with the user's explicit consent (NSMicrophoneUsageDescription
prompt) and transcribes it locally using whisper.cpp. No audio leaves
the device — no network calls are made with the recording.

The UIBackgroundModes [audio] entitlement is used solely so that the
recording does not stop when the user locks their phone during a long
meeting (typical session length is 30-60 minutes). The persistent red
microphone indicator in the iOS status bar remains visible the entire
time the app is recording, so the user always knows the microphone is
in use.

To verify in review:
  1. Launch the app.
  2. Tap "Start Meeting" — the red mic indicator appears in the
     status bar.
  3. Lock the phone (side button). The recording continues — the
     red mic indicator remains visible behind the lock screen clock.
  4. Unlock. Open Aizuchi. The mind-map has updated with whatever
     was said during the locked period.
  5. Tap "End Meeting". The red mic indicator disappears
     immediately.

The app does not play any audio in the background. The audio entry
in UIBackgroundModes is required for the *recording* side of the
session, not playback.

We are also requesting NSSpeechRecognitionUsageDescription only if
you observe the SFSpeechRecognizer-on-device fallback codepath
trigger; the primary path is whisper.cpp and does not use Apple's
Speech framework.

Privacy policy: https://aizuchi.tools/privacy
```

(Adapt the last two lines to match the actual privacy URL and
SFSpeechRecognizer status at submission time.)

---

## Pre-emptive checklist before submitting

- [ ] Red mic indicator appears within 500 ms of `setActive(true)` and remains for the entire capture session.
- [ ] App stops recording when the user taps "End Meeting" — and the red mic indicator disappears immediately. (Easy to break: `setActive(false)` must be called, not just stopping the engine.)
- [ ] No third-party SDK in the binary has microphone access. (Reviewers grep `Info.plist` against the binary's symbol table.)
- [ ] Privacy policy URL is live and explicitly mentions audio handling.
- [ ] App Tracking Transparency: not required if no cross-app tracking. Aizuchi does no tracking, so we don't request ATT.
- [ ] Reviewer test account credentials, if Aizuchi has accounts — not currently relevant.
- [ ] App icon does not look like a "stealth recorder" (single-colour mic icon on black background is a known trigger). Aizuchi's mind-map icon is fine.

---

## If we get rejected

Most likely rejection reason: **Guideline 2.5.4** — "Multitasking apps may only use background services for their intended purposes."

The response template:

> The audio entry in UIBackgroundModes is required for the app's core
> feature, which is transcribing the user's ongoing meeting into a
> live mind-map. The recording continues across screen-lock because
> meetings are 30-60 minutes long and users put their phones in their
> bag. We use the same UIBackgroundModes entitlement and audio session
> configuration (.playAndRecord category, .measurement mode) as
> SFSpeechRecognizer-based dictation apps; the only difference is that
> our transcription model runs locally on the user's device rather
> than via Apple's network speech service.
>
> The microphone status indicator (red dot in the system status bar)
> remains visible to the user throughout the recording, including
> while the screen is locked.

If the reviewer pushes back, request escalation through App Review Board citing the prior approval of comparable apps (Otter, Krisp, Just Press Record, Apple Notes' own transcription feature). These all use `.playAndRecord + UIBackgroundModes: [audio]` for the same purpose.
