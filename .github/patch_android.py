"""Adds what voice questions need to the generated Android manifest:
the microphone permission and visibility of the phone's speech services."""
import pathlib
import sys

manifest = pathlib.Path(sys.argv[1]) / "app" / "src" / "main" / "AndroidManifest.xml"
text = manifest.read_text(encoding="utf-8")
if "android.permission.RECORD_AUDIO" not in text:
    extra = """    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <queries>
        <intent>
            <action android:name="android.speech.RecognitionService" />
        </intent>
        <intent>
            <action android:name="android.intent.action.TTS_SERVICE" />
        </intent>
    </queries>
"""
    text = text.replace("</manifest>", extra + "</manifest>")
    manifest.write_text(text, encoding="utf-8")
print("manifest ready:", "RECORD_AUDIO" in text)
