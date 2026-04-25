const fs = require('fs');
const path = require('path');

/**
 * This script recreates config.json and the Firebase service account file
 * from environment variables on Heroku.
 */

console.log('--- Running Heroku Setup ---');

// 1. Recreate config.json
if (process.env.CONFIG_JSON && process.env.CONFIG_JSON.trim().length > 0) {
    try {
        // Validate it's actual JSON before writing
        JSON.parse(process.env.CONFIG_JSON);
        fs.writeFileSync(path.join(__dirname, 'config.json'), process.env.CONFIG_JSON);
        console.log('Successfully created config.json');
    } catch (e) {
        console.error('ERROR: CONFIG_JSON env var contains invalid JSON:', e.message);
        process.exit(1);
    }
} else {
    console.warn('WARNING: CONFIG_JSON environment variable is not set or is empty.');
}

// 2. Recreate Firebase Service Account file
if (process.env.FIREBASE_KEY && process.env.FIREBASE_KEY.trim().length > 0) {
    console.log('Recreating Firebase Service Account file from FIREBASE_KEY env var...');

    let firebasePath = 'firebase-adminsdk.json'; // Default fallback

    // Try to get the path from the config we just wrote
    try {
        const configText = process.env.CONFIG_JSON || fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
        const config = JSON.parse(configText);
        if (config.GOOGLE_APPLICATION_CREDENTIALS) {
            firebasePath = config.GOOGLE_APPLICATION_CREDENTIALS;
        }
    } catch (e) {
        console.error('Error parsing config to find firebase path:', e.message);
    }

    fs.writeFileSync(path.join(__dirname, firebasePath), process.env.FIREBASE_KEY);
    console.log(`Successfully created Firebase key at: ${firebasePath}`);
} else {
    console.warn('WARNING: FIREBASE_KEY environment variable is not set or is empty.');
}

console.log('--- Heroku Setup Complete ---');
