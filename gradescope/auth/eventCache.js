/**
 * Event Cache Module
 * Performance optimization for Calendar API - caches Gradescope events
 *
 * Reduces API calls by maintaining an in-memory cache of existing events
 * Full refresh every 10 minutes.
 *
 * Part of background.js refactoring
 */

class EventCache {
    constructor(calendarClient) {
        this.client = calendarClient;
        this.cache = new Map();
        this.lastFullRefresh = null;
        this.CACHE_DURATION = 10 * 60 * 1000; // 10 minutes
        this.refreshPromise = null;

        console.log('💾 Event cache initialized');
    }

    async getExistingEvent(assignmentId) {
        // Never treat a failed Calendar lookup as a cache miss; doing so could
        // create duplicates while Google Calendar is temporarily unavailable.
        await this.ensureCacheValid();
        const cachedData = this.cache.get(assignmentId);
        return cachedData ? { id: cachedData.eventId, ...cachedData.eventData } : null;
    }

    async ensureCacheValid() {
        const now = Date.now();
        const cacheAge = this.lastFullRefresh ? (now - this.lastFullRefresh) : Infinity;

        if (cacheAge < this.CACHE_DURATION) return;

        if (this.refreshPromise) return await this.refreshPromise;

        console.log('🔄 Cache expired, refreshing...');
        this.refreshPromise = this.refreshCache();

        try {
            await this.refreshPromise;
        } finally {
            this.refreshPromise = null;
        }
    }

    async refreshCache() {
        try {
            const events = await this.getAllGradescopeEvents();
            this.cache.clear();

            let cachedCount = 0;
            events.forEach(event => {
                const properties = event.extendedProperties?.private;
                let assignmentId = properties?.gradescope_assignment_id;
                if (assignmentId && !assignmentId.includes(':') && properties?.gradescope_course) {
                    assignmentId = `${properties.gradescope_course}:${assignmentId}`;
                }
                if (assignmentId && !this.cache.has(assignmentId)) {
                    this.cache.set(assignmentId, {
                        eventId: event.id,
                        lastUpdated: Date.now(),
                        eventData: {
                            summary: event.summary,
                            start: event.start,
                            end: event.end,
                            htmlLink: event.htmlLink
                        }
                    });
                    cachedCount++;
                }
            });

            this.lastFullRefresh = Date.now();
            console.log(`✅ Cache refresh complete: ${cachedCount} events cached`);

        } catch (error) {
            console.error('❌ Cache refresh failed:', error);
            throw error;
        }
    }

    async getAllGradescopeEvents() {
        try {
            const allEvents = [];
            let pageToken;
            do {
                const params = new URLSearchParams({ singleEvents: 'true', maxResults: '2500' });
                if (pageToken) params.set('pageToken', pageToken);
                const response = await this.client.makeAPIRequest(`/calendars/primary/events?${params}`);
                allEvents.push(...(response.items || []));
                pageToken = response.nextPageToken;
            } while (pageToken);

            const gradescopeEvents = allEvents.filter(event =>
                Boolean(event.extendedProperties?.private?.gradescope_assignment_id)
            );

            console.log(`📡 Found ${gradescopeEvents.length} Gradescope events out of ${allEvents.length} total`);
            return gradescopeEvents;

        } catch (error) {
            console.error('❌ API call failed:', error);
            throw error;
        }
    }

    invalidateAssignment(assignmentId) {
        this.cache.delete(assignmentId);
    }

    addToCache(assignmentId, eventData) {
        this.cache.set(assignmentId, {
            eventId: eventData.id,
            lastUpdated: Date.now(),
            eventData: {
                summary: eventData.summary,
                start: eventData.start,
                end: eventData.end,
                htmlLink: eventData.htmlLink
            }
        });
        console.log(`💾 Added event to cache: ${assignmentId} → ${eventData.id}`);
    }

    async forceRefresh() {
        this.lastFullRefresh = null;
        this.cache.clear();
        await this.ensureCacheValid();
    }

    getStats() {
        return {
            size: this.cache.size,
            lastRefresh: this.lastFullRefresh ? new Date(this.lastFullRefresh).toISOString() : 'Never',
            cacheAge: this.lastFullRefresh ? Date.now() - this.lastFullRefresh : null,
            isValid: this.lastFullRefresh && (Date.now() - this.lastFullRefresh) < this.CACHE_DURATION
        };
    }
}

// Expose for service worker context
if (typeof self !== 'undefined') {
    self.EventCache = EventCache;
}
