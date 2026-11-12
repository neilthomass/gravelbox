"use strict";

class TokenManager {
    constructor() {
        this.accessToken = null;
        this.tokenExpiry = null;
        this.authMethod = null;
    }

    async initializeFromStorage() {
        const stored = await browser.storage.local.get('google_auth_method');
        this.authMethod = stored.google_auth_method === 'chrome_native' ? 'chrome_native' : null;
        // Retire the secret-based fallback, including old tokens on upgrades.
        await browser.storage.local.remove([
            'google_access_token', 'google_refresh_token', 'google_token_expiry'
        ]);
        if (!this.authMethod) await browser.storage.local.remove('google_auth_method');
    }

    async saveTokenState() {
        await browser.storage.local.set({ google_auth_method: this.authMethod });
    }

    async clearStoredAuth() {
        this.accessToken = null;
        this.tokenExpiry = null;
        this.authMethod = null;
        await browser.storage.local.remove([
            'google_auth_method', 'google_access_token',
            'google_refresh_token', 'google_token_expiry'
        ]);
    }

    async getValidToken(chromeTokenCallback) {
        if (this.accessToken && Date.now() < this.tokenExpiry - 60000) return this.accessToken;
        if (this.authMethod === 'chrome_native' && chromeTokenCallback) return chromeTokenCallback();
        throw new Error('Connect Google Calendar to continue.');
    }

    setChromeToken(token) {
        this.accessToken = token;
        this.tokenExpiry = Date.now() + 3600000;
        this.authMethod = 'chrome_native';
    }

    async invalidateToken() {
        const token = this.accessToken;
        this.accessToken = null;
        this.tokenExpiry = null;
        if (token) {
            await new Promise((resolve) => {
                chrome.identity.removeCachedAuthToken({ token }, () => {
                    void chrome.runtime.lastError;
                    resolve();
                });
            });
        }
    }

    isAuthenticated() { return this.authMethod === 'chrome_native'; }
    getAuthMethod() { return this.authMethod; }
    getAccessToken() { return this.accessToken; }
}

if (typeof self !== 'undefined') self.TokenManager = TokenManager;
