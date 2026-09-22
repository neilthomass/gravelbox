/**
 * Assignment Parser Utilities
 * Handles course extraction and assignment parsing from Gradescope pages
 *
 * Extracted from contentScript.js for better maintainability
 */

class AssignmentParser {
    /**
     * Extract course cards from dashboard page
     */
    static extractCoursesFromDashboard() {
        console.log('🏠 Extracting courses from dashboard...');

        const currentSemester = DateParser.getCurrentSemester();
        const courses = [];

        const courseCards = document.querySelectorAll('.courseList--coursesForTerm .courseBox');
        const actualCourseCards = Array.from(courseCards).filter(card =>
            !card.classList.contains('courseBox-new') &&
            !card.textContent.includes('Add a course')
        );

        console.log(`📚 Processing ${actualCourseCards.length} course cards`);

        actualCourseCards.forEach((card, index) => {
            const term = card.closest('.courseList--coursesForTerm')?.previousElementSibling?.textContent?.trim();
            const courseData = this.extractCourseFromCard(card, term || currentSemester);
            if (courseData) {
                courses.push(courseData);
                console.log(`✅ Course ${index + 1}: ${courseData.shortName}`);
            }
        });

        return courses;
    }

    /**
     * Parse individual course card for metadata
     */
    static extractCourseFromCard(card, semester) {
        try {
            const courseLink = card.href;
            if (!courseLink) return null;

            const courseIdMatch = courseLink.match(/\/courses\/(\d+)/);
            if (!courseIdMatch) return null;
            const courseId = courseIdMatch[1];

            const shortNameEl = card.querySelector('.courseBox--shortname');
            const shortName = shortNameEl?.textContent?.trim() || `Course ${courseId}`;

            const fullNameEl = card.querySelector('.courseBox--name');
            const fullName = fullNameEl?.textContent?.trim() || shortName;

            return {
                id: courseId,
                shortName: shortName,
                fullName: fullName,
                url: new URL(courseLink, window.location.origin).href,
                semester: semester,
                extractedAt: new Date().toISOString()
            };

        } catch (error) {
            console.log('⚠️ Error parsing course card:', error);
            return null;
        }
    }

    /**
     * Extract ALL assignments from a course for comprehensive grade data
     */
    static async extractAllAssignmentsForGrades(course) {
        console.log(`📡 Extracting ALL assignments from ${course.shortName} for grade calculation...`);

        try {
            let doc;

            if (window.location.href.includes(`/courses/${course.id}`)) {
                doc = document;
            } else {
                const response = await fetch(course.url, {
                    credentials: 'same-origin',
                    headers: {
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Cache-Control': 'no-cache'
                    }
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const html = await response.text();
                const parser = new DOMParser();
                doc = parser.parseFromString(html, 'text/html');
            }

            return this.parseAllAssignmentsFromDocument(doc, course);

        } catch (error) {
            console.log(`❌ Error extracting from ${course.shortName}:`, error.message);
            return [];
        }
    }

    /**
     * Parse assignment table from course page document
     */
    static parseAllAssignmentsFromDocument(doc, course) {
        console.log(`📋 Parsing ALL assignments with categorization from ${course.shortName}...`);

        const assignments = [];

        // Check for multiple tables (Gradescope might have separate tables for different categories)
        const allTables = doc.querySelectorAll('table');
        console.log(`🔍 Found ${allTables.length} table(s) on page for ${course.shortName}`);

        if (allTables.length === 0) {
            console.log(`❌ No assignment tables found for ${course.shortName}`);
            return assignments;
        }

        // Process ALL tables (in case assignments are split across multiple tables)
        allTables.forEach((table, tableIndex) => {
            const rows = table.querySelectorAll('tbody tr');
            console.log(`📋 Table ${tableIndex + 1}: ${rows.length} rows`);

            rows.forEach((row, index) => {
                try {
                    // DEBUG: Log what we're trying to parse
                    const firstCell = row.querySelector('th, td');
                    const rowPreview = firstCell?.textContent?.trim() || '(empty)';
                    console.log(`🔄 Table ${tableIndex + 1}, Row ${index + 1}: "${rowPreview}"`);

                    const assignment = this.parseAssignmentFromRow(row, course);
                    if (assignment) {
                        assignments.push(assignment);
                        console.log(`  ✅ Parsed: "${assignment.title}" (${assignment.submissionStatus})`);
                    } else {
                        console.log(`  ❌ Skipped`);
                    }
                } catch (error) {
                    console.log(`  ⚠️ Error:`, error.message);
                }
            });
        });

        console.log(`✅ Extracted ${assignments.length} assignments from ${course.shortName}`);
        return assignments;
    }

    /**
     * Parse individual assignment row with comprehensive grade data extraction
     */
    static parseAssignmentFromRow(row, course) {
        const thElements = row.querySelectorAll('th');
        const tdElements = row.querySelectorAll('td');

        if (thElements.length > 0 && tdElements.length === 0) {
            return null; // Header row
        }

        // Try multiple selectors for different Gradescope layouts
        let titleElement = row.querySelector('button.js-submitAssignment, button[data-assignment-id]');

        // Fallback 1: Look for any link to /assignments/
        if (!titleElement) {
            titleElement = row.querySelector('a[href*="/assignments/"]');
        }

        // Fallback 2: Look for any button or link in the first column (common for "No Submission" rows)
        if (!titleElement) {
            const firstCell = row.querySelector('th, td');
            if (firstCell) {
                titleElement = firstCell.querySelector('button, a');
            }
        }

        // Fallback 3: Look for any text in first cell (last resort)
        if (!titleElement) {
            const firstCell = row.querySelector('th, td');
            if (firstCell && firstCell.textContent?.trim()) {
                console.log(`⚠️ Using text-only extraction for row: ${firstCell.textContent.trim()}`);
                // Create a pseudo-element with the text content
                titleElement = { textContent: firstCell.textContent.trim() };
            }
        }

        if (!titleElement) {
            console.log(`❌ Could not find title element in row:`, row.innerHTML.substring(0, 100));
            return null;
        }

        const title = titleElement.textContent?.trim();

        // Try to extract assignment ID from various sources
        let assignmentId = titleElement.getAttribute?.('data-assignment-id');

        if (!assignmentId && titleElement.href) {
            const match = titleElement.href.match(/assignments\/(\d+)/);
            assignmentId = match?.[1];
        }

        // Fallback: Extract from onclick or other attributes
        if (!assignmentId) {
            const onclickMatch = titleElement.getAttribute?.('onclick')?.match(/(\d+)/);
            assignmentId = onclickMatch?.[1];
        }

        // Fallback: Use title as ID if nothing else works (create hash)
        if (!assignmentId && title) {
            // Create a simple hash from title for consistent ID
            assignmentId = 'pseudo_' + title.replace(/\s+/g, '_').toLowerCase();
            console.log(`⚠️ Generated pseudo-ID for "${title}": ${assignmentId}`);
        }

        if (!title || !assignmentId) {
            console.log(`❌ Missing title or ID - Title: "${title}", ID: "${assignmentId}"`);
            return null;
        }

        const cells = row.querySelectorAll('td, th');
        let dueDate = DateParser.extractDueDateFromRow(cells);

        // Detect timezone (Tier 1: Gradescope, Tier 2: Browser)
        const timezone = DateParser.detectTimezone(cells);

        const assignmentUrl = `https://www.gradescope.com/courses/${course.id}/assignments/${assignmentId}`;

        return {
            title: title,
            dueDate: dueDate ? dueDate.toISOString() : null,
            timezone: timezone,  // Store detected timezone
            course: course.shortName || course.fullName || 'Unknown Course',
            courseId: course.id,
            url: assignmentUrl,
            assignmentId: assignmentId,
            extractedAt: new Date().toISOString(),
            pageUrl: course.url || window.location.href,
            autoDiscovered: true,
            semester: course.semester
        };
    }

    /**
     * Parse assignment row with automatic categorization
     */
    static parseAssignmentFromRowWithCategories(row, course) {
        const basicAssignment = this.parseAssignmentFromRow(row, course);

        if (!basicAssignment) {
            return null;
        }

        // Add automatic categorization
        const categorization = AssignmentCategorizer.categorizeAssignment(
            basicAssignment.title,
            basicAssignment.course,
            basicAssignment.url
        );

        return {
            ...basicAssignment,
            category: categorization.category,
            categoryConfidence: categorization.confidence,
            categoryInfo: AssignmentCategorizer.getCategoryInfo(categorization.category),
            categorization: {
                alternates: categorization.alternates,
                reason: categorization.reason,
                source: categorization.source
            }
        };
    }

    /**
     * Extract from individual course page
     */
    static extractFromCoursePage() {
        console.log('📄 Extracting from individual course page with categorization...');

        const courseId = window.location.pathname.match(/\/courses\/(\d+)/)?.[1];
        const courseNameEl = document.querySelector('h1, .course-title, .course-name');
        const courseName = courseNameEl?.textContent?.trim() || `Course ${courseId}`;

        const course = {
            id: courseId,
            shortName: courseName,
            fullName: courseName,
            url: window.location.href,
            semester: DateParser.getCurrentSemester()
        };

        const allAssignments = this.parseAllAssignmentsFromDocument(document, course);
        const calendarAssignments = allAssignments.filter(assignment => assignment.dueDate);

        return { allAssignments, calendarAssignments };
    }

    /**
     * Fast comprehensive extraction from dashboard page
     */
    static async fastComprehensiveExtraction() {
        console.log('🚀 Starting fast comprehensive extraction...');

        const courses = this.extractCoursesFromDashboard();

        if (courses.length === 0) {
            console.log('❌ No courses found in current semester');
            return { allAssignments: [], calendarAssignments: [] };
        }

        console.log(`📚 Found ${courses.length} courses, extracting ALL assignments...`);

        // Extract ALL assignments from ALL courses in parallel
        const allAssignmentsPromises = courses.map(course => this.extractAllAssignmentsForGrades(course));
        const courseAssignments = await Promise.all(allAssignmentsPromises);

        // Flatten all assignments
        const allAssignments = courseAssignments.flat();
        console.log(`📊 Total assignments extracted: ${allAssignments.length}`);

        const calendarAssignments = allAssignments.filter(assignment => assignment.dueDate);

        console.log(`🎯 Results: ${allAssignments.length} total assignments, ${calendarAssignments.length} for calendar`);

        return { allAssignments, calendarAssignments };
    }
}

// Expose to window for contentScript usage
if (typeof window !== 'undefined') {
    window.AssignmentParser = AssignmentParser;
}
