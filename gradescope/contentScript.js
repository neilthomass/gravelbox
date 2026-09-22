/* Extracts Gradescope assignments and sends them to Google Calendar. */

let runningSync = null;

async function extractAndSync() {
    if (runningSync) return runningSync;

    runningSync = (async () => {
        const pageType = PageDetector.detectPageType();
        let extracted;

        if (pageType === 'dashboard') {
            extracted = await AssignmentParser.fastComprehensiveExtraction();
        } else if (pageType === 'course_main' || pageType === 'course_assignments') {
            extracted = AssignmentParser.extractFromCoursePage();
        } else {
            return { success: false, error: 'Open the Gradescope dashboard or a course page.' };
        }

        const assignments = extracted.allAssignments.filter(assignment => assignment.dueDate);
        const uniqueAssignments = Array.from(new Map(
            assignments.map(assignment => [
                `${assignment.courseId || assignment.course}:${assignment.assignmentId}`,
                assignment
            ])
        ).values());

        await browser.storage.local.set({
            assignments_latest: {
                assignments: uniqueAssignments,
                extractedAt: new Date().toISOString(),
                pageUrl: window.location.href
            }
        });

        if (uniqueAssignments.length === 0) {
            return { success: true, results: { created: 0, skipped: 0, errors: 0 } };
        }

        const auth = await browser.runtime.sendMessage({ action: 'gradescopeGetAuthStatus' });
        if (!auth?.success || !auth.authenticated || !auth.tokenValid) {
            return { success: false, error: 'Connect Google Calendar in the extension popup first.' };
        }

        return browser.runtime.sendMessage({
            action: 'gradescopeSyncToCalendar',
            assignments: uniqueAssignments
        });
    })();

    try {
        return await runningSync;
    } finally {
        runningSync = null;
    }
}

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action !== 'gradescopeManualSync') return false;
    extractAndSync().then(sendResponse).catch(error => {
        sendResponse({ success: false, error: error.message });
    });
    return true;
});

function start() {
    PageDetector.setupOptimizedDOMObserver(extractAndSync);
    extractAndSync().catch(error => console.error('Gradescope sync failed:', error));
}

if (!window.gradescopeCalendarSyncLoaded) {
    window.gradescopeCalendarSyncLoaded = true;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(start, 750), { once: true });
    } else {
        setTimeout(start, 750);
    }
}
