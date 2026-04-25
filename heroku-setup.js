const fs = require('fs');
const path = require('path');

/**
 * This script recreates config.json and the Firebase service account file
 * from environment variables on Heroku.
 *
 * IMPORTANT: config.json is NOT committed to source control.
 * On Heroku it must be recreated from the CONFIG_JSON env var.
 * Locally, if config.json already exists, this script skips recreation
 * so your local config is never overwritten.
 */

console.log('--- Running Heroku Setup ---');

const configPath = path.join(__dirname, 'config.json');

// 1. Handle config.json
let config = null;
let configExistsLocally = false;

// First, check if a valid config.json already exists (local dev)
if (fs.existsSync(configPath)) {
    try {
        const raw = fs.readFileSync(configPath, 'utf8');
        config = JSON.parse(raw);
        configExistsLocally = true;
        console.log('config.json already exists locally — skipping env var recreation.');
    } catch (e) {
        console.warn('config.json exists but is invalid JSON. Will attempt to recreate from env var.');
    }
}

// If no valid local config, try to recreate from env var (Heroku)
if (!configExistsLocally) {
    if (process.env.CONFIG_JSON && process.env.CONFIG_JSON.trim().length > 0) {
        try {
            config = JSON.parse(process.env.CONFIG_JSON);
            fs.writeFileSync(configPath, process.env.CONFIG_JSON);
            console.log('Successfully created config.json from CONFIG_JSON env var.');
        } catch (e) {
            console.error('ERROR: CONFIG_JSON env var contains invalid JSON:', e.message);
            console.warn('         Skipping config.json creation. The app may crash at runtime.');
        }
    } else {
        console.warn('WARNING: CONFIG_JSON env var is not set and config.json is missing.');
        console.warn('         The app will likely crash at runtime when it tries to read config.json.');
    }
}

// 2. Recreate Firebase Service Account file
if (process.env.FIREBASE_KEY && process.env.FIREBASE_KEY.trim().length > 0) {
    let firebasePath = 'firebase-adminsdk.json';

    // Try to resolve the Firebase key path from config
    try {
        let configText = null;
        if (process.env.CONFIG_JSON && process.env.CONFIG_JSON.trim().length > 0) {
            configText = process.env.CONFIG_JSON;
        } else if (fs.existsSync(configPath)) {
            configText = fs.readFileSync(configPath, 'utf8');
        }
        if (configText) {
            const parsed = JSON.parse(configText);
            if (parsed.GOOGLE_APPLICATION_CREDENTIALS) {
                firebasePath = parsed.GOOGLE_APPLICATION_CREDENTIALS;
            }
        }
    } catch (e) {
        console.warn('Could not resolve Firebase key path from config, using default:', firebasePath);
    }

    fs.writeFileSync(path.join(__dirname, firebasePath), process.env.FIREBASE_KEY);
    console.log(`Successfully created Firebase key at: ${firebasePath}`);
} else {
    console.warn('WARNING: FIREBASE_KEY env var is not set. Firebase Admin will fail to initialize.');
}

console.log('--- Heroku Setup Complete ---');
