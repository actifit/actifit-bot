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
 *
 * Runtime order of precedence for config.json:
 * 1. If config.json exists locally — skip recreation (respects local dev config)
 * 2. If CONFIG_JSON env var is valid JSON — recreate config.json from it (Heroku)
 * 3. Otherwise — warn and skip (build succeeds, runtime will fail)
 */

console.log('--- Running Heroku Setup ---');

const configPath = path.join(__dirname, 'config.json');

// 1. Handle config.json
let config = null;
let configLoaded = false;

// First: check if valid config.json already exists (local dev or already setup on Heroku)
if (fs.existsSync(configPath)) {
    try {
        const raw = fs.readFileSync(configPath, 'utf8');
        if (raw && raw.trim().length > 0) {
            config = JSON.parse(raw);
            configLoaded = true;
            console.log('config.json already exists and is valid — using existing config.');
        }
    } catch (e) {
        // Invalid JSON, will try env var
    }
}

// Second: if no config, try to load from CONFIG_JSON env var
if (!configLoaded) {
    console.log('config.json not found or invalid. Checking CONFIG_JSON env var...');
    
    // Support both plain JSON and base64 encoded (for long config values)
    const rawEnv = process.env.CONFIG_JSON || process.env.CONFIG_JSON_B64 || '';
    
    if (rawEnv.trim().length > 0) {
        try {
            // Check if it's base64 encoded
            if (process.env.CONFIG_JSON_B64 || rawEnv.match(/^[A-Za-z0-9+/=]+$/)) {
                try {
                    config = JSON.parse(Buffer.from(rawEnv.trim(), 'base64').toString('utf8'));
                    console.log('Loaded config from base64-encoded CONFIG_JSON_B64');
                } catch (e) {
                    // Not valid base64, try as plain JSON
                    config = JSON.parse(rawEnv);
                    console.log('Loaded config from plain CONFIG_JSON');
                }
            } else {
                config = JSON.parse(rawEnv);
                console.log('Loaded config from plain CONFIG_JSON');
            }
            
            // Write the resolved config back to config.json for runtime
            const configJsonStr = Buffer.from(rawEnv.trim(), 'base64').toString('utf8');
            fs.writeFileSync(configPath, configJsonStr);
            console.log('Successfully created config.json from environment variable.');
            configLoaded = true;
        } catch (e) {
            console.error('ERROR: Failed to parse CONFIG_JSON:', e.message);
        }
    }
}

if (!configLoaded) {
    console.warn('WARNING: No valid config found. The app will crash at runtime.');
    console.warn('Expected: Either config.json file or CONFIG_JSON / CONFIG_JSON_B64 env var.');
}

// 2. Recreate Firebase Service Account file
if (process.env.FIREBASE_KEY && process.env.FIREBASE_KEY.trim().length > 0) {
    let firebasePath = 'firebase-adminsdk.json';

    // Try to resolve the Firebase key path from config
    try {
        if (config && config.GOOGLE_APPLICATION_CREDENTIALS) {
            firebasePath = config.GOOGLE_APPLICATION_CREDENTIALS;
        }
    } catch (e) {
        console.warn('Could not resolve Firebase key path from config, using default:', firebasePath);
    }

    fs.writeFileSync(path.join(__dirname, firebasePath), process.env.FIREBASE_KEY);
    console.log(`Successfully created Firebase key at: ${firebasePath}`);
} else {
    console.warn('WARNING: FIREBASE_KEY env var not set. Firebase will fail to initialize.');
}

console.log('--- Heroku Setup Complete ---');
