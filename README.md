# Google Drive => Discord Notifications
This script sends Team Drive change notifications to Discord via webhook. It's meant to run periodically via cronjob.

## Setup
1. Install Node.js version 7.6.0 or above (need async/await support).
2. Run `npm install` at repository root to fetch node dependencies.
3. Copy `config/default.template.js` to `config/default.js` and fill out (see instructions in file).
4. Run `npm start` to execute script.

## Required Credentials
The setup instructions in `config/default.template.js` walk you through getting these:

1. Discord Webhook Id + Token
2. Google Drive API v3 `client_secret.json` (make sure to select `other`, not `node.js` when prompted for secret type).

## Running Things + Persisted Data
All non-configuration state is stored in `./data` (overridable in config), which contains three items:
1. head (directory) - contains dumps of latest-known Google Drive state. Files named by Google Drive file id.
2. name (directory) - contains last-known filenames by Google Drive file id.
3. last_page_token (file) - identifies last-processed Google Drive snapshot (sorta).

### Resetting to a clean slate
Deleting `data` forces a clean download of team drives on next run (and therefore won't notify of any prior changes).
