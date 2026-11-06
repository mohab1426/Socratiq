// LAYOUT-ONLY FIXTURES. These intercept the network so authenticated pages can be rendered and measured
// without a Supabase project or backend. They prove nothing about the real API; they exist to check layout,
// responsive behaviour, empty/error states and accessibility of the UI itself.
const now = Date.now()
const iso = (offsetDays, h = 0) => new Date(now + offsetDays * 86_400_000 + h * 3_600_000).toISOString()

const me = (role) => ({
  id: role === "teacher" ? "t-1" : "s-1",
  name: role === "teacher" ? "Dr. Amira Hassan-Abdelrahman" : "Mohab Elsayed Ibrahim",
  email: role === "teacher" ? "amira.hassan.abdelrahman@faculty.university.example.edu" : "mohab.elsayed@student.university.example.edu",
  role, universityId: "U-2028-0042", firstName: "A", lastName: "B",
})

const courses = [
  { id: "c1", code: "CS201", name: "Data Structures and Algorithms for Large-Scale Systems", description: "Lists, trees, graphs, and the trade-offs between them.", teacher: "Dr. Amira Hassan", status: "Active", color: "plum", materialCount: 6, assignmentCount: 4, studentCount: 38, classroomId: "cl1", joinCode: "K7Q-2MX" },
  { id: "c2", code: "CS340", name: "Machine Learning", description: "Supervised and unsupervised learning.", teacher: "Dr. Amira Hassan", status: "Active", color: "teal", materialCount: 3, assignmentCount: 2, studentCount: 31, classroomId: "cl2", joinCode: "P4D-9ZA" },
  { id: "c3", code: "MA110", name: "Calculus I", description: "Limits, derivatives, integrals.", teacher: "Dr. Omar Nasser", status: "Archived", color: "clay", materialCount: 0, assignmentCount: 0, studentCount: 0 },
]
const file = (name, status = "READY") => ({ fileId: "f-" + name, filename: name, extension: name.split(".").pop(), mimeType: "application/pdf", sizeBytes: 482113, kind: "DOCUMENT", indexMode: "RAG", status, pageCount: 24, createdAt: iso(-5) })
const materials = [
  { id: "m1", courseId: "c1", title: "Week 3 — Sorting algorithms and their trade-offs (slides)", summary: "Bubble, merge, quick and heap sort with complexity analysis and worked examples.", kind: "slides", file: file("week3-sorting.pdf"), createdAt: iso(-9) },
  { id: "m2", courseId: "c1", title: "Reading: Chapter 4", summary: "Trees and traversal.", kind: "reading", file: file("ch4.pdf", "PROCESSING"), createdAt: iso(-4) },
  { id: "m3", courseId: "c1", title: "Dataset: runtime measurements", summary: "CSV of measured runtimes.", kind: "dataset", file: file("runtimes.csv", "FAILED"), createdAt: iso(-2) },
]
const assignments = [
  { id: "a1", courseId: "c1", title: "Sorting algorithms and trade-offs", topic: "Sorting", prompt: "Compare merge sort and quicksort on nearly sorted input. Explain which you would choose and why, with the worst-case complexity of each.", status: "in_progress", dueDate: iso(2), aiMode: "guided", lifecycle: "PUBLISHED", version: 1, attachments: [file("brief.pdf")] },
  { id: "a2", courseId: "c1", title: "Binary search trees", topic: "Trees", prompt: "Implement insertion and deletion.", status: "not_started", dueDate: iso(9), aiMode: "assisted", lifecycle: "PUBLISHED", version: 1 },
  { id: "a3", courseId: "c1", title: "Graph traversal", topic: "Graphs", prompt: "BFS and DFS.", status: "submitted", dueDate: iso(-3), aiMode: "guided", lifecycle: "PUBLISHED", version: 2 },
  { id: "a4", courseId: "c1", title: "Hash tables", topic: "Hashing", prompt: "Collision handling.", status: "verified", dueDate: iso(-12), aiMode: "open", lifecycle: "PUBLISHED", version: 1 },
]
const grade = { score: 17, maxScore: 20, percentage: 85, feedback: "Clear reasoning. Revisit the amortised cost argument.", gradedAt: iso(-1), gradedBy: "Dr. Amira Hassan" }
const long = "Think about what has to change on each pass for the loop condition to become false. If `i` never moves toward `n`, which line is responsible for moving it? Try tracing the first three iterations by hand with `arr = [5, 2, 9, 1]` and write down the value of every variable at the end of each pass, including `swapped`."
const chat = [
  { id: "1", role: "student", content: "My loop never stops and I can't see why." },
  { id: "2", role: "coach", content: long, kind: "hint" },
  { id: "3", role: "student", content: "def bubble(arr):\n    for i in range(len(arr)):\n        for j in range(len(arr) - i - 1):\n            if arr[j] > arr[j + 1]:\n                arr[j], arr[j + 1] = arr[j + 1], arr[j]  # swap adjacent elements when out of order" },
  { id: "4", role: "coach", content: "Good. Now what does the inner loop's range do as `i` grows? Check complexity: O(n²) comparisons in the worst case.", kind: "question" },
]
const riskBrief = (level, reason) => ({ level, levelLabel: { low: "Low", moderate: "Moderate", high: "High", insufficient: "Insufficient evidence" }[level], score: level === "insufficient" ? null : 42, confidenceLabel: "Medium", evidenceCount: 5, primaryReason: reason, focus: "work_pattern", lastActivityAt: iso(-1) })
const students = [
  { id: "s2", name: "Layla Mahmoud Abdelfattah Ibrahim", taskSubmission: 80, socraticAiUsage: 55, observedSignalRate: 25, observedSignalCount: 1, mastery: "Moderate", risk: riskBrief("moderate", "Submission followed a long gap with no coach activity") },
  { id: "s3", name: "Karim Adel", taskSubmission: 100, socraticAiUsage: 20, observedSignalRate: 0, mastery: "Strong", risk: riskBrief("low", null) },
  { id: "s4", name: "Nour El-Din", taskSubmission: 40, socraticAiUsage: 90, observedSignalRate: 50, mastery: "Weak", risk: riskBrief("high", "Verification answers did not match the submitted work") },
  { id: "s5", name: "Youssef Hany", taskSubmission: 0, socraticAiUsage: 0, observedSignalRate: 0, mastery: null, risk: riskBrief("insufficient", null) },
]
const assessment = (level) => ({ level, levelLabel: level === "moderate" ? "Moderate" : "Low", score: 42, confidence: 0.6, confidenceLabel: "Medium", evidenceCount: 5, activityUnits: 9, minActivityUnits: 4,
  topSignals: [{ signal: "long_gap", label: "Long gap before submission", category: "work_pattern", categoryLabel: "Work pattern", severity: "MEDIUM", meaning: "Work appeared after a long period with no recorded activity.", count: 2, points: 10, mitigatedCount: 0, evidence: [{ source: "submission", refId: "x1", assignmentId: "a1", at: iso(-2), detail: "Submitted 41 hours after the last coach turn", learningEventId: null, mitigated: false }] }],
  reasons: ["Long gap before submission"], explanation: "Some recorded patterns are worth a closer look.", primaryReason: "Long gap before submission", focus: "work_pattern", mitigating: { assignmentsWithPassedVerification: 1, strongPositiveEvidence: 1 }, lastEvidenceAt: iso(-1),
  disclaimer: "This is a review-priority indicator based on recorded activity. It is not evidence of misconduct and not a prediction.", modelVersion: "v1" })
const dashboard = {
  course: courses[0],
  overview: { students: 38, activeStudents: 29, needsReview: 2, needsSupport: 3, assignments: 4, verificationsCompleted: 21, riskDistribution: { low: 28, moderate: 6, high: 2, insufficient: 2 } },
  reviewQueue: [
    { studentId: "s4", name: "Nour El-Din", kind: "risk_review", level: "high", levelLabel: "High", primaryReason: "Verification answers did not match the submitted work", focus: "verification", evidenceCount: 4, confidenceLabel: "Medium", lastActivityAt: iso(-1), assignmentId: "a1", assignmentTitle: "Sorting algorithms and trade-offs" },
    { studentId: "s2", name: "Layla Mahmoud Abdelfattah Ibrahim", kind: "risk_review", level: "moderate", levelLabel: "Moderate", primaryReason: "Submission followed a long gap with no coach activity", focus: "work_pattern", evidenceCount: 2, confidenceLabel: "Low", lastActivityAt: iso(-2), assignmentId: "a3", assignmentTitle: "Graph traversal" },
    { studentId: "s5", name: "Youssef Hany", kind: "learning_support", level: null, levelLabel: null, primaryReason: "Weak verified mastery of Hashing", focus: "learning_difficulty", evidenceCount: null, confidenceLabel: "Low", lastActivityAt: null, assignmentId: null, assignmentTitle: null },
  ],
  riskDisclaimer: "Review-priority indicators are heuristics built from recorded activity. They are not validated predictions.",
  metrics: { assignmentCompletion: 72, averageGrade: null, socraticAiUsage: 48, observedSignalRate: 9, verificationRate: 66 },
  students,
  attention: [{ id: "at1", kind: "deadline", title: "Graph traversal closes tomorrow", description: "11 students have not submitted.", tone: "warning", target: { type: "assignment", assignmentId: "a3" } }],
  activity: [
    { id: "ac1", date: iso(0, -2), courseId: "c1", assignmentId: "a1", assignmentTitle: "Sorting algorithms and trade-offs", kind: "submission", detail: "Layla submitted a file" },
    { id: "ac2", date: iso(-1), courseId: "c1", assignmentId: "a1", assignmentTitle: "Sorting algorithms and trade-offs", kind: "coach_session", detail: "Karim finished a coach session" },
  ],
}
const studentDetail = {
  id: "s2", name: "Layla Mahmoud Abdelfattah Ibrahim", email: "layla.mahmoud@student.university.example.edu", courseIds: ["c1"], mastery: "Moderate", taskSubmission: 80, socraticAiUsage: 55, observedSignalRate: 25, attempts: 6, revisions: 3,
  strugglingTopics: ["Amortised analysis", "Heap invariants"],
  signals: [{ label: "Long gap before submission", detail: "41 hours without activity", tone: "watch" }],
  activity: dashboard.activity, risk: assessment("moderate"), lastActivityAt: iso(-1),
  assignments: [{ assignmentId: "a1", courseId: "c1", title: "Sorting algorithms and trade-offs", dueAt: iso(2), submitted: true, verificationOutcome: "PASSED", coachTurns: 7 }],
  aiUsage: { interactions: 14, sessions: 4, firstAt: iso(-12), lastAt: iso(-1), byIntervention: [{ type: "hint", label: "Hint", count: 8 }], byDiagnosis: [{ type: "gap", label: "Concept gap", count: 5 }], perAssignment: [{ assignmentId: "a1", title: "Sorting algorithms and trade-offs", turns: 7 }] },
  verification: [{ id: "v1", assignmentId: "a1", courseId: "c1", assignmentTitle: "Sorting algorithms and trade-offs", status: "COMPLETED", outcome: "PASSED", score: 0.8, startedAt: iso(-2), completedAt: iso(-2), questions: [{ type: "EXPLAIN", concept: "Merge sort", outcome: "PASSED", feedback: "Clear." }] }],
  concepts: [{ name: "Merge sort", level: "Strong", mastery: 0.82, evidenceCount: 4, lastEvaluatedAt: iso(-2), recentScores: [0.6, 0.8], trend: "up", assignments: [{ assignmentId: "a1", title: "Sorting" }], coachMentions: 3 }, { name: "Heaps", level: "Weak", mastery: 0.3, evidenceCount: 2, lastEvaluatedAt: iso(-4), recentScores: [0.4, 0.3], trend: "down", assignments: [], coachMentions: 1 }],
  timeline: [
    { id: "t1", at: iso(-3), kind: "attempt", label: "Started attempt 1", assignmentId: "a1", assignmentTitle: "Sorting algorithms and trade-offs", courseId: "c1", flagged: false, signals: [] },
    { id: "t2", at: iso(-2), kind: "coach", label: "Coach session (7 turns)", assignmentId: "a1", assignmentTitle: "Sorting algorithms and trade-offs", courseId: "c1", flagged: false, signals: [] },
    { id: "t3", at: iso(-1), kind: "submission", label: "Submitted file", assignmentId: "a1", assignmentTitle: "Sorting algorithms and trade-offs", courseId: "c1", flagged: true, signals: ["Long gap before submission"] },
  ],
}
const teacherAssignment = { ...assignments[0], submissions: [
  { studentId: "s2", studentName: "Layla Mahmoud Abdelfattah Ibrahim", status: "submitted", mastery: "Moderate", submittedAt: iso(-1) },
  { studentId: "s3", studentName: "Karim Adel", status: "verified", mastery: "Strong", submittedAt: iso(-2) },
  { studentId: "s5", studentName: "Youssef Hany", status: "not_started", mastery: null, submittedAt: null } ],
  linkedMaterials: [{ id: "m1", title: "Week 3 — Sorting slides" }], concepts: ["Merge sort", "Quicksort"], counts: { students: 38, submitted: 27, verified: 19 } }
const review = { assignment: { id: "a1", title: "Sorting algorithms and trade-offs", version: 1 }, student: { id: "s2", name: "Layla Mahmoud Abdelfattah Ibrahim", email: "layla@student.university.example.edu" },
  attempt: { id: "at1", number: 2, status: "SUBMITTED", assignmentVersion: 1 },
  submission: { id: "sub1", type: "FILE", submittedAt: iso(-1), textPreview: "Merge sort guarantees O(n log n) in every case, whereas quicksort degrades to O(n²) on nearly sorted input unless the pivot is chosen carefully. ".repeat(4), textTruncated: true, file: file("layla-answer.pdf") },
  verification: { id: "v1", status: "COMPLETED", outcome: "PASSED", entries: [{ label: "Explain", prompt: "In your own words, why is merge sort stable?", answer: "Because equal elements are taken from the left half first.", outcome: "PASSED", feedback: "Accurate." }] },
  grade: null, whiteboard: null, coachInteractions: 7, signals: dashboard.reviewQueue.length ? [{ label: "Long gap", detail: "41h", tone: "watch" }] : [], signalsNote: "Observed activity only.", risk: assessment("moderate") }
const verifyState = { verificationId: "v9", status: "IN_PROGRESS", outcome: null, steps: [{ type: "EXPLAIN", status: "done" }, { type: "MODIFY", status: "current" }, { type: "TRANSFER", status: "upcoming" }], current: { questionId: "q2", type: "MODIFY", question: "Change your merge step so that it is stable for records with equal keys. What do you alter, and why does it matter?", index: 1 }, needsQuestion: false }
const caps = { purpose: "x", extensions: ["pdf", "docx", "txt", "py"], accept: ".pdf,.docx,.txt,.py", maxBytes: 20971520, formats: [{ extension: "pdf", kind: "DOCUMENT", label: "PDF document", mimeType: "application/pdf", mode: "RAG", maxBytes: 20971520 }] }

function respond(role, scenario, method, p) {
  const empty = scenario === "empty"
  if (p === "/me") return me(role)
  if (p.startsWith("/files/capabilities")) return caps
  if (p === "/student/home") return { user: { id: "s-1", name: me("student").name }, courses: empty ? [] : courses.slice(0, 2), assignments: empty ? [] : assignments }
  if (p === "/student/courses" || p === "/teacher/courses") return { courses: empty ? [] : courses }
  if (p === "/student/courses/c1") return { course: courses[0], materials: empty ? [] : materials, assignments: empty ? [] : assignments }
  if (p.startsWith("/student/materials/")) return materials[0]
  if (p === "/student/assignments/a1") return { ...assignments[0], attempt: { id: "at1", attemptNumber: 2, status: "OPEN", startedAt: iso(-1), draftText: null }, submission: null, verification: null, grade: null }
  if (p === "/student/assignments/a3") return { ...assignments[2], attempt: { id: "at3", attemptNumber: 1, status: "SUBMITTED", startedAt: iso(-5) }, submission: { id: "sub3", type: "FILE", submittedAt: iso(-3), filename: "graph-traversal-final-version-v3.pdf" }, verification: { id: "v1", status: "COMPLETED", outcome: "PASSED" }, grade }
  if (p.startsWith("/student/assignments/") && p.endsWith("/coach")) return { messages: empty ? [] : chat }
  if (p.startsWith("/student/assignments/") && p.endsWith("/whiteboard")) return { updatedAt: null }
  if (p.startsWith("/student/assignments/") && p.endsWith("/verification")) return verifyState
  if (p.startsWith("/student/assignments/")) return { ...assignments[1], attempt: null, submission: null, verification: null, grade: null }
  if (p === "/teacher/courses/c1") return { course: courses[0], classrooms: [{ id: "cl1", name: "Section A", joinCode: "K7Q-2MX", joinEnabled: true }, { id: "cl2", name: "Section B", joinCode: "P4D-9ZA", joinEnabled: false }], materials: empty ? [] : materials, assignments: empty ? [] : assignments.map((a) => ({ ...a, lifecycle: a.id === "a2" ? "DRAFT" : "PUBLISHED", submittedCount: 12, studentCount: 38 })) }
  if (p === "/teacher/courses/c1/dashboard") return empty ? { ...dashboard, overview: { ...dashboard.overview, students: 0, activeStudents: 0, needsReview: 0, needsSupport: 0 }, reviewQueue: [], students: [], attention: [], activity: [] } : dashboard
  if (/^\/teacher\/students\//.test(p)) return studentDetail
  if (p === "/teacher/assignments/a1") return teacherAssignment
  if (/^\/teacher\/assignments\/a1\/students\//.test(p)) return review
  if (p.startsWith("/teacher/materials/")) return materials[0]
  return undefined
}

export async function mockSetup(page, role, scenario) {
  const session = { access_token: "header.payload.signature", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: me(role).id, aud: "authenticated", email: me(role).email } }
  await page.addInitScript((s) => { localStorage.setItem("sb-127-auth-token", JSON.stringify(s)) }, session)
  await page.route("**/auth/v1/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: session.user }) }))
  await page.route("**/api/v1/**", async (r) => {
    const url = new URL(r.request().url())
    const p = url.pathname.replace(/^\/api\/v1/, "")
    if (scenario === "error" && p !== "/me") return r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "boom", code: "internal" } }) })
    if (scenario === "slow" && p !== "/me") await new Promise((res) => setTimeout(res, 4000))
    const body = respond(role, scenario, r.request().method(), p)
    if (body === undefined) return r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found", code: "not_found" } }) })
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
  })
}

const S = "/student", T = "/teacher"
export const mockRoutes = [
  { path: S, role: "student" }, { path: S, role: "student", scenario: "empty" }, { path: S, role: "student", scenario: "error" },
  { path: S + "/join", role: "student" }, { path: S + "/courses", role: "student" },
  { path: S + "/courses/c1", role: "student" }, { path: S + "/courses/c1/materials/m1", role: "student" },
  { path: S + "/courses/c1/assignments/a1", role: "student" }, { path: S + "/courses/c1/assignments/a3", role: "student" },
  { path: S + "/courses/c1/assignments/a1/coach", role: "student", wait: 1500 }, { path: S + "/courses/c1/assignments/a1/coach", role: "student", scenario: "empty", wait: 1200 },
  { path: S + "/courses/c1/assignments/a1/verify", role: "student" }, { path: S + "/settings", role: "student" },
  { path: T, role: "teacher", wait: 1500 }, { path: T, role: "teacher", scenario: "empty", wait: 1200 }, { path: T, role: "teacher", scenario: "error" },
  { path: T + "/students/s2", role: "teacher" }, { path: T + "/courses", role: "teacher" }, { path: T + "/courses/new", role: "teacher" },
  { path: T + "/courses/c1", role: "teacher" }, { path: T + "/courses/c1/assignments/new", role: "teacher" }, { path: T + "/courses/c1/materials/new", role: "teacher" },
  { path: T + "/courses/c1/assignments/a1", role: "teacher" }, { path: T + "/courses/c1/assignments/a1/submissions/s2", role: "teacher" },
  { path: T + "/courses/c1/materials/m1", role: "teacher" }, { path: T + "/settings", role: "teacher" },
]
