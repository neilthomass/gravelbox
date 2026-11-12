"use strict";

// Chrome manages OAuth credentials and token renewal. No web-client secret or
// refresh token belongs in the extension package or its storage.
class AuthenticationManager {
    constructor(config, tokenManager) {
        this.config = config;
        this.tokenManager = tokenManager;
    }

    isSupported() {
        return typeof chrome !== 'undefined'
            && typeof chrome.identity?.getAuthToken === 'function'
            && Boolean(this.config.CHROME_EXTENSION_CLIENTS[chrome.runtime.id]);
    }

    async requestToken(interactive) {
        if (!this.isSupported()) {
            throw new Error('Calendar sync requires Google Chrome and a registered extension installation.');
        }
        const token = await new Promise((resolve, reject) => {
            chrome.identity.getAuthToken({ interactive }, (result) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                const value = typeof result === 'string' ? result : result?.token;
                if (value) resolve(value);
                else reject(new Error('Connect Google Calendar to continue.'));
            });
        });
        this.tokenManager.setChromeToken(token);
        await this.tokenManager.saveTokenState();
        return token;
    }

    async authenticate() {
        await this.requestToken(true);
        return true;
    }

    async getChromeToken() {
        if (this.tokenManager.getAuthMethod() !== 'chrome_native') {
            throw new Error('Connect Google Calendar to continue.');
        }
        return this.requestToken(false);
    }

    async getAuthStatus() {
        let tokenValid = false;
        if (this.isSupported() && this.tokenManager.isAuthenticated()) {
            try {
                await this.tokenManager.getValidToken(() => this.getChromeToken());
                tokenValid = true;
            } catch (_) { /* The popup offers reconnection without prompting here. */ }
        }
        return {
            authenticated: this.tokenManager.isAuthenticated(),
            tokenValid,
            authMethod: 'chrome_native',
            supported: this.isSupported()
        };
    }

    async clearAuth() {
        const token = this.tokenManager.getAccessToken();
        await this.tokenManager.clearStoredAuth();
        if (token && chrome.identity?.removeCachedAuthToken) {
            await new Promise((resolve, reject) => {
                chrome.identity.removeCachedAuthToken({ token }, () => {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve();
                });
            });
        }
    }
}

if (typeof self !== 'undefined') self.AuthenticationManager = AuthenticationManager;
