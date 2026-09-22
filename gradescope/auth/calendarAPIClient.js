/**
 * Calendar API Client Module
 * Handles all Google Calendar API operations
 *
 * Creates events, syncs assignments, performs background sync
 * Uses TokenManager for authentication and EventCache for performance
 *
 * Part of background.js refactoring
 */

class CalendarAPIClient {
    constructor(config, tokenManager, authenticationManager) {
        this.config = config;
        this.tokenManager = tokenManager;
        this.authManager = authenticationManager;
        this.eventCache = new EventCache(this);
    }

    // ============================================================================
    // CALENDAR API OPERATIONS
    // ============================================================================

    async makeAPIRequest(endpoint, options = {}) {
        const token = await this.tokenManager.getValidToken(
            () => this.authManager.getChromeToken()
        );

        const url = `${this.config.CALENDAR_API_BASE}${endpoint}`;
        const requestOptions = {
            ...options,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                ...options.headers
            }
        };

        const method = (requestOptions.method || 'GET').toUpperCase();
        const attempts = method === 'GET' ? 3 : 1;
        let response;
        let networkError;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                response = await fetch(url, requestOptions);
                networkError = null;
                break;
            } catch (error) {
                networkError = error;
                if (attempt < attempts) {
                    await new Promise(resolve => setTimeout(resolve, 250 * attempt));
                }
            }
        }

        if (!response) {
            throw new Error(
                `Google Calendar could not be reached after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${networkError?.message || 'network error'}`
            );
        }

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ API Error: ${response.status} ${response.statusText}`, errorText);

            if (response.status === 401) {
                this.tokenManager.setTokens(null, this.tokenManager.refreshToken, 0, this.tokenManager.getAuthMethod());
            }

            throw new Error(`API request failed: ${response.status} ${response.statusText}`);
        }

        return response.json();
    }

    async createEventFromAssignment(assignment) {
        const dueDate = new Date(assignment.dueDate);
        if (Number.isNaN(dueDate.getTime())) throw new Error('Invalid due date');

        const timezone = assignment.timezone || 'UTC';
        const parts = Object.fromEntries(
            new Intl.DateTimeFormat('en-US', {
                timeZone: timezone,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            }).formatToParts(dueDate).map(part => [part.type, part.value])
        );
        const dateOnly = `${parts.year}-${parts.month}-${parts.day}`;
        const followingDay = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1))
            .toISOString().slice(0, 10);
        const syncId = this.getAssignmentKey(assignment);

        const event = {
            summary: `${assignment.course}: ${assignment.title}`,
            description: `Gradescope assignment\n${assignment.url}`,
            transparency: 'transparent',
            source: {
                title: 'Gradescope',
                url: assignment.url
            },
            extendedProperties: {
                private: {
                    gradescope_assignment_id: syncId,
                    gradescope_course: assignment.course,
                    gradescope_url: assignment.url,
                    gradescope_due_time: assignment.dueDate
                }
            },
            start: { date: dateOnly },
            // Google Calendar requires the end date of an all-day event to be exclusive.
            end: { date: followingDay },
            reminders: { useDefault: false, overrides: [] }
        };

        const response = await this.makeAPIRequest('/calendars/primary/events', {
            method: 'POST',
            body: JSON.stringify(event)
        });

        // Add newly created event to cache (prevents duplicates on rapid re-sync)
        this.eventCache.addToCache(syncId, response);
        return response;
    }

    getAssignmentKey(assignment) {
        return `${assignment.course || assignment.courseId || 'course'}:${assignment.assignmentId}`;
    }

    async findExistingEvent(assignmentId) {
        try {
            return await this.eventCache.getExistingEvent(assignmentId);
        } catch (error) {
            console.error(`❌ Error finding event ${assignmentId}:`, error.message);
            throw new Error(`Could not verify existing Calendar events: ${error.message}`);
        }
    }

    async syncAssignments(assignments) {
        const results = {
            created: 0,
            skipped: 0,
            errors: 0,
            details: []
        };

        for (const assignment of assignments) {
            try {
                if (!assignment.dueDate) {
                    results.skipped++;
                    results.details.push({
                        assignment: assignment.title,
                        status: 'skipped',
                        reason: 'No due date'
                    });
                    continue;
                }

                const existingEvent = await this.findExistingEvent(this.getAssignmentKey(assignment));

                if (existingEvent) {
                    results.skipped++;
                    results.details.push({
                        assignment: assignment.title,
                        status: 'skipped',
                        reason: 'Already exists',
                        eventId: existingEvent.id
                    });
                    continue;
                }

                await this.createEventFromAssignment(assignment);
                results.created++;
                results.details.push({
                    assignment: assignment.title,
                    status: 'created',
                    dueDate: assignment.dueDate
                });

                await new Promise(resolve => setTimeout(resolve, 100));

            } catch (error) {
                console.error(`❌ Failed to sync ${assignment.title}:`, error);
                results.errors++;
                results.details.push({
                    assignment: assignment.title,
                    status: 'error',
                    error: error.message
                });
            }
        }

        return results;
    }

    async performBackgroundSync() {
        try {
            const authStatus = await this.authManager.getAuthStatus();
            if (!authStatus.authenticated) {
                return {
                    success: false,
                    reason: 'Authentication needed',
                    needsReauth: true,
                    silent: true
                };
            }

            try {
                await this.tokenManager.getValidToken(
                    () => this.authManager.getChromeToken()
                );
            } catch (error) {
                return {
                    success: false,
                    reason: 'Authentication expired',
                    needsReauth: true,
                    silent: true
                };
            }

            const assignments = await this.getAllStoredAssignments();
            if (assignments.length === 0) {
                await browser.storage.local.set({
                    last_auto_sync: new Date().toISOString(),
                    last_sync_results: { created: 0, skipped: 0, errors: 0 },
                    lastSyncType: 'auto'
                });
                return {
                    success: true,
                    reason: 'No assignments to sync',
                    results: { created: 0, skipped: 0, errors: 0 }
                };
            }

            const results = await this.syncAssignments(assignments);

            await browser.storage.local.set({
                last_auto_sync: new Date().toISOString(),
                last_sync_results: results,
                lastSyncType: 'auto'
            });

            return { success: true, results };

        } catch (error) {
            console.error('❌ Background sync failed:', error);

            await browser.storage.local.set({
                last_auto_sync_error: {
                    timestamp: new Date().toISOString(),
                    error: error.message
                }
            });

            return {
                success: false,
                error: error.message,
                silent: true
            };
        }
    }

    async getAllStoredAssignments() {
        try {
            const storage = await browser.storage.local.get();
            if (Array.isArray(storage.assignments_latest?.assignments)) {
                return Array.from(new Map(
                    storage.assignments_latest.assignments.map(assignment => [
                        this.getAssignmentKey(assignment), assignment
                    ])
                ).values());
            }
            const assignmentKeys = Object.keys(storage).filter(key => key.startsWith('assignments_'));

            let allAssignments = [];
            assignmentKeys.forEach(key => {
                if (storage[key].assignments) {
                    allAssignments.push(...storage[key].assignments);
                }
            });

            const uniqueAssignments = Array.from(new Map(allAssignments.map(assignment => [
                this.getAssignmentKey(assignment), assignment
            ])).values());

            return uniqueAssignments;
        } catch (error) {
            console.error('Error getting assignments:', error);
            return [];
        }
    }

    // ============================================================================
    // CACHE OPERATIONS
    // ============================================================================

    getCacheStats() {
        return this.eventCache.getStats();
    }

    async forceCacheRefresh() {
        await this.eventCache.forceRefresh();
    }
}

// Expose for service worker context
if (typeof self !== 'undefined') {
    self.CalendarAPIClient = CalendarAPIClient;
}
