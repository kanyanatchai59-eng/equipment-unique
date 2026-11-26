# EQUIPMENT Unique

LIFF app for borrowing and returning Survey equipment (Unique, BPNP project) through LINE.

- LIFF URL: https://liff.line.me/2012756966-P652TGXb
- Hosting: GitHub Pages (`index.html` in this repo)
- Backend: Google Apps Script web app (`gas/Code.gs`) with data in Google Sheets
- No secrets, employee data or equipment data live in this repo. The LINE channel access token is kept in Apps Script Script Properties.

## Pages

| Link | Opens |
|---|---|
| `?v=borrow` | Borrow (scan QR / type a code) |
| `?v=return` | Return |
| `?v=mine` | My tickets |
| `?v=admin` | Back office (ADMIN / STORE / CHECKER / VIEWER) |
| `?v=cal` | Calibration page (sent in the weekly LINE recall) |
| `?c=<asset code>` | QR on equipment labels |
| `?t=<ticket id>` | QR on a ticket |

## v1.3 (design from Figma)

- Screens rebuilt from the Figma file *EQUIPMENT Unique · ระบบเบิก–คืน v1.2*: same tokens as Queue Unique (IBM Plex Sans Thai, warm greys, Unique red), motion with `prefers-reduced-motion` respected.
- Damage photos: up to 3 per returned item, shrunk in the browser to ≤1280 px JPEG, saved by the backend to a Drive folder of the deploying account (`drive.file` scope). Only the borrower and back-office users can open them, through the app.
- Weekly calibration recall: every Monday at `CAL_WEEKLY_HOUR` (default 8) store keepers and admins get a LINE message with overdue / recall-now counts. Turn off with `NOTIFY_CAL_WEEKLY`.
- After updating `Code.gs`, run `setup()` once in the Apps Script editor: it adds the `photos` columns and the two new settings, and asks for the new Drive permission.
