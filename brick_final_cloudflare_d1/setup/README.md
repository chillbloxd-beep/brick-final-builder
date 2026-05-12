# Setup Folder

This lets you configure everything once and generate ready folders.

## Use

1. Copy `setup-config.example.json` to `setup-config.json`, or run:

```bash
node setup/build.js
```

2. Edit `setup/setup-config.json`.
3. Edit `setup/devices.csv`.
4. Run:

```bash
node setup/build.js
```

5. Upload `output/dashboard-ready/` to GitHub Pages.
6. Load the matching `output/extension-ready/<deviceId>/` folder on each student computer.
