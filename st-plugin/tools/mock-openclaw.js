#!/usr/bin/env node

/**
 * Mock OpenClaw Client
 * 
 * Simulates an OpenClaw agent using the character-bridge skill to send messages
 * to SillyTavern via the bridge plugin. Useful for end-to-end testing without
 * needing a real OpenClaw instance.
 * 
 * Usage:
 *   node mock-openclaw.js [options]
 * 
 * Options:
 *   --character <name>    Character to message (default: Frog)
 *   --message <text>      Message to send (default: "Hello!")
 *   --user-id <id>        User ID in format platform:id (default: "discord:123456789")
 *   --channel <name>      Channel name (default: "discord")
 *   --owner               Mark sender as owner (sets user_id to owner in link state)
 *   --url <url>           Plugin base URL (default: http://127.0.0.1:8000)
 *   --token <token>       Bearer token (default: read from data/openclaw-bridge/bridge-token.txt)
 *   --test-scenario       Run predefined test scenarios (interactive menu)
 * 
 * Example:
 *   node mock-openclaw.js --character Frog --message "Ribbit!" --user-id discord:user123
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DEFAULT_PLUGIN_URL = 'http://127.0.0.1:8000';
const DEFAULT_CHARACTER = 'Frog';
const DEFAULT_MESSAGE = 'Hello!';
const DEFAULT_USER_ID = 'discord:123456789';
const DEFAULT_CHANNEL = 'discord';

class MockOpenClawClient {
    constructor(options = {}) {
        this.pluginUrl = options.url || DEFAULT_PLUGIN_URL;
        this.token = options.token || this.loadTokenFromFile();
        this.character = options.character || DEFAULT_CHARACTER;
        this.message = options.message || DEFAULT_MESSAGE;
        this.userId = options.userId || DEFAULT_USER_ID;
        this.channel = options.channel || DEFAULT_CHANNEL;
    }

    loadTokenFromFile() {
        const candidatePaths = [
            path.resolve(__dirname, '../../data/openclaw-bridge/bridge-token.txt'),
            path.resolve(process.cwd(), 'data/openclaw-bridge/bridge-token.txt'),
            path.resolve(process.cwd(), '../data/openclaw-bridge/bridge-token.txt'),
        ];

        for (const tokenPath of candidatePaths) {
            try {
                if (fs.existsSync(tokenPath)) {
                    return fs.readFileSync(tokenPath, 'utf8').trim();
                }
            } catch (err) {
                // Continue to next path
            }
        }

        throw new Error('Bridge token not found. Run ./setup.sh first or set --token.');
    }

    async generate(message, userId, channel) {
        const endpoint = `${this.pluginUrl}/api/plugins/openclaw-bridge/generate`;
        const headers = {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
        };

        const body = {
            character: this.character,
            message,
            channel,
            user_id: userId,
            images: [],
        };

        console.log(`\n[MockOC] POST ${endpoint}`);
        console.log(`[MockOC] Character: ${this.character}`);
        console.log(`[MockOC] User ID: ${userId}`);
        console.log(`[MockOC] Channel: ${channel}`);
        console.log(`[MockOC] Message: ${message}`);

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });

            const responseText = await response.text();
            let responseData;
            try {
                responseData = JSON.parse(responseText);
            } catch {
                responseData = { raw: responseText };
            }

            console.log(`[MockOC] Status: ${response.status}`);
            console.log(`[MockOC] Response:`, JSON.stringify(responseData, null, 2));

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${responseText}`);
            }

            return responseData;
        } catch (error) {
            console.error(`[MockOC] Error: ${error.message}`);
            throw error;
        }
    }

    async logAction(actionDescription, channel) {
        const endpoint = `${this.pluginUrl}/api/plugins/openclaw-bridge/log-action`;
        const headers = {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
        };

        const body = {
            character: this.character,
            action_description: actionDescription,
            channel: channel || this.channel,
        };

        console.log(`\n[MockOC] POST ${endpoint}`);
        console.log(`[MockOC] Character: ${this.character}`);
        console.log(`[MockOC] Action: ${actionDescription}`);

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });

            const responseText = await response.text();
            let responseData;
            try {
                responseData = JSON.parse(responseText);
            } catch {
                responseData = { raw: responseText };
            }

            console.log(`[MockOC] Status: ${response.status}`);
            console.log(`[MockOC] Response:`, JSON.stringify(responseData, null, 2));

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${responseText}`);
            }

            return responseData;
        } catch (error) {
            console.error(`[MockOC] Error: ${error.message}`);
            throw error;
        }
    }
}

async function runTestScenario(choice, client) {
    switch (choice) {
        case '1': {
            console.log('\n=== Test: Guest user sends message ===');
            await client.generate(
                'Hi Frog, how are you today?',
                'discord:guest-user-123',
                'discord'
            );
            break;
        }

        case '2': {
            console.log('\n=== Test: Owner sends message ===');
            await client.generate(
                'Change your behavior to be less verbose',
                'discord:owner-user-456',
                'discord'
            );
            break;
        }

        case '3': {
            console.log('\n=== Test: Multiple messages from different users ===');
            console.log('\n--- Message 1: Guest user ---');
            await client.generate(
                'What is your favorite food?',
                'discord:guest1',
                'discord'
            );

            await new Promise(resolve => setTimeout(resolve, 1000));

            console.log('\n--- Message 2: Different guest user ---');
            await client.generate(
                'Do you like ponds?',
                'discord:guest2',
                'discord'
            );

            await new Promise(resolve => setTimeout(resolve, 1000));

            console.log('\n--- Message 3: Owner user ---');
            await client.generate(
                'Respond to both guests now',
                'discord:owner',
                'discord'
            );
            break;
        }

        case '4': {
            console.log('\n=== Test: Log autonomous action ===');
            await client.logAction('Posted a picture of a lily pad', 'discord');
            break;
        }

        case '5': {
            console.log('\n=== Test: Full workflow (message + action) ===');
            console.log('\n--- User sends message ---');
            const response = await client.generate(
                'Draw something for me!',
                'discord:user-xyz',
                'discord'
            );

            console.log('\n--- Character logs autonomous action ---');
            await client.logAction('Drew a detailed lily pad drawing', 'discord');

            console.log('\n--- Conversation continues ---');
            await client.generate(
                'That drawing is beautiful!',
                'discord:user-xyz',
                'discord'
            );
            break;
        }

        case '6': {
            console.log('\n=== Test: Character message from Toad ===');
            client.character = 'Toad';
            await client.generate(
                'I found a new book at the library',
                'telegram:librarian-42',
                'telegram'
            );
            break;
        }

        default:
            console.log('Unknown scenario');
    }
}

async function interactiveMenu() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

    try {
        console.log('\n╔════════════════════════════════════════╗');
        console.log('║  Mock OpenClaw Client - Test Scenarios  ║');
        console.log('╚════════════════════════════════════════╝\n');

        let client;
        try {
            client = new MockOpenClawClient();
            console.log(`✓ Connected with character: ${client.character}`);
            console.log(`✓ Plugin URL: ${client.pluginUrl}`);
            console.log(`✓ Token loaded: ${client.token.substring(0, 8)}...`);
        } catch (err) {
            console.error(`✗ Failed to initialize: ${err.message}`);
            rl.close();
            return;
        }

        let running = true;
        while (running) {
            console.log('\nTest Scenarios:');
            console.log('  1. Guest user sends message');
            console.log('  2. Owner sends message');
            console.log('  3. Multiple messages from different users');
            console.log('  4. Log autonomous action');
            console.log('  5. Full workflow (message + autonomous action)');
            console.log('  6. Character message from Toad');
            console.log('  0. Exit');

            const choice = await question('\nSelect scenario (0-6): ');

            if (choice === '0') {
                running = false;
            } else {
                try {
                    await runTestScenario(choice, client);
                } catch (err) {
                    console.error(`\n✗ Test failed: ${err.message}`);
                }
            }
        }

        console.log('\nGoodbye!');
    } finally {
        rl.close();
    }
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('--test-scenario')) {
        await interactiveMenu();
        return;
    }

    // Parse command-line arguments
    const options = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--character') {
            options.character = args[++i];
        } else if (args[i] === '--message') {
            options.message = args[++i];
        } else if (args[i] === '--user-id') {
            options.userId = args[++i];
        } else if (args[i] === '--channel') {
            options.channel = args[++i];
        } else if (args[i] === '--url') {
            options.url = args[++i];
        } else if (args[i] === '--token') {
            options.token = args[++i];
        } else if (args[i] === '--owner') {
            // Note: This would require loading link state to find owner ID
            console.warn('--owner flag requires manual owner_user_ids setup. Use --user-id instead.');
        } else if (args[i] === '--help' || args[i] === '-h') {
            console.log(`
Mock OpenClaw Client

Usage:
  node mock-openclaw.js [options]

Options:
  --character <name>    Character to message (default: ${DEFAULT_CHARACTER})
  --message <text>      Message to send (default: "${DEFAULT_MESSAGE}")
  --user-id <id>        User ID format: platform:id (default: ${DEFAULT_USER_ID})
  --channel <name>      Channel name (default: ${DEFAULT_CHANNEL})
  --url <url>           Plugin base URL (default: ${DEFAULT_PLUGIN_URL})
  --token <token>       Bearer token (default: read from file)
  --test-scenario       Run interactive test menu
  --help                Show this message

Examples:
  # Send a message as a guest user
  node mock-openclaw.js --character Frog --message "Ribbit!" --user-id discord:user123

  # Send as owner
  node mock-openclaw.js --character Toad --message "Change mood to happy" --user-id discord:owner-user

  # Run test scenarios
  node mock-openclaw.js --test-scenario
            `);
            process.exit(0);
        }
    }

    try {
        const client = new MockOpenClawClient(options);
        await client.generate(
            client.message,
            client.userId,
            client.channel
        );
    } catch (err) {
        console.error(`\nError: ${err.message}`);
        process.exit(1);
    }
}

main().catch(err => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
});
