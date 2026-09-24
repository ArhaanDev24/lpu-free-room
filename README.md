# LPU Free Room

Find free rooms on campus by slot, block and floor, or by asking out loud.
Students see free rooms; teachers (verified @lpu.co.in accounts) also see every
class and can open any room, section, staff or course timetable on a timeline.

## What is where

| Path | What it is |
|---|---|
| `docs/app/lib/freeroom.js` | The free-room logic, on its own: reads the UMS report, builds the published files, answers "is it free". Time parsing is a port of `engine.parse_time_label`, checked against all 77 labels in the live CSV. |
| `docs/app/lib/nlu.js` | Understands typed or spoken questions and writes the answers. |
| `docs/app/` | The app. The same files run in the browser and inside the APK. |
| `docs/admin/` | The page where you upload the timetable and room details and publish. |
| `docs/data/` | What phones download. Written only by the admin page. |
| `backend/Code.gs` | Teacher sign-in: accounts, emailed 6-digit codes, key release (Google Apps Script). |
| `app/`, `.github/` | Builds the Android APK on GitHub's servers whenever the app changes. |
| `test/` | Tests for all of the above. |

## One-time setup (about 20 minutes, all in the browser)

**1. Create the repository.** On github.com: New repository, name `lpu-free-room`,
Public, Create. On the empty repository page click *uploading an existing file*
and drag in everything inside this folder (`.github`, `app`, `backend`, `docs`,
`test`, `README.md`). Commit.
If `.github` did not come across, use *Add file > Create new file*, type
`.github/workflows/apk.yml` as the name and paste that file; do the same for
`.github/patch_android.py`.

**2. Turn on the website.** Settings > Pages > Build and deployment: *Deploy from
a branch*, branch `main`, folder `/docs`, Save. About a minute later the site is at
`https://<your-username>.github.io/lpu-free-room/`.

**3. Get the APK.** The Actions tab shows *Build Android app* running (6 to 10
minutes). When it turns green, the APK is under Releases and the site's
*Download the Android app* button points to it. If it never started: Actions >
Build Android app > Run workflow.

**4. Start the sign-in service.** Use a personal Gmail account (a college
Workspace account may block the "Anyone" access phones need).
script.google.com > New project > paste `backend/Code.gs` over the sample > Save.
Pick `setup` in the function list > Run > allow the permissions. The log shows
the **admin secret** and the link to the accounts sheet. Then Deploy > New
deployment > type *Web app*, Execute as *Me*, Who has access *Anyone* > Deploy,
and copy the **Web app URL** (ends in `/exec`).

**5. Make a publishing token.** github.com > Settings > Developer settings >
Personal access tokens > Fine-grained tokens > Generate new token. Repository
access: *Only select repositories* > `lpu-free-room`. Permissions: *Contents:
Read and write*. Generate and copy it.

**6. Publish.** Open `https://<your-username>.github.io/lpu-free-room/admin/`,
paste the token, the Web app URL and the admin secret, Connect. Drop the UMS
report CSV (and a room-details CSV or Excel file if you have one), *Build and
check*, *Publish*. Compare the numbers it shows with the timetable-audit
dashboard: on 23 Sep 2026 the live file read as 48,391 classes, 0 unreadable.

## Updating the timetable later

Open the admin page, Connect, drop the new report and/or room details, Build and
check, Publish. Uploading only room details keeps the published timetable, and
uploading only a timetable keeps the published room details. Phones pick up the
change the next time the app opens.

## Why downloads stay small

Each time the app opens it fetches `data/manifest.json` (about 0.4 KB). The room
file and the class-details file are named by a hash of their content, so a phone
downloads them only when that name changes. On the live data that is 21 KB for
a student and 276 KB for a teacher, once per timetable change.

## Privacy and access

- The repository is public. The room file (which rooms are busy when, plus room
  details) is readable by anyone. Class details (course, section, staff) are
  compressed and encrypted with AES-GCM; the key is released only to signed-in
  teachers by the sign-in service.
- Teacher accounts need an @lpu.co.in address proven by an emailed code. To
  remove someone, delete their row in the *LPU Free Room accounts* sheet; their
  app loses access at its next key check.
- If the key may have leaked, run `rotateDataKey` in Apps Script, then publish
  again. Teachers' apps fetch the new key automatically.
- Students sign in with any email, as requested; it is not verified.
- Email codes come from your Google account: 100 a day on Gmail. The service
  limits each address to 3 codes per 15 minutes and 5 tries per code.

## About the APK

- It is debug-signed, so Android asks to allow installs from the browser.
- Every app rebuild gets a new signing key, so installing a newer APK over an
  older one fails with "App not installed": uninstall first. Timetable updates
  never need a new APK. Stable signing needs two repository secrets; ask when
  you want it.
- Voice questions use the phone's Google speech service in Indian English.
  Typing works everywhere.

## Tests

```
node test/test_logic.js      # parsing, encoding, self-check, questions
node test/test_backend.js    # sign-in service against stand-in Google services
npm install jsdom
node test/test_ui.js         # app screens, student and teacher flows
node test/test_admin.js      # admin page against a stand-in GitHub
```
