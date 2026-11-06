import { matchPath } from "react-router-dom"

/** One title per route so browser tabs, history and screen-reader page announcements say where the user is. Most specific pattern first. */
const TITLES: [pattern: string, title: string][] = [
  ["/", "Think first"],
  ["/signup", "Sign up"],
  ["/signup/student", "Sign up as a student"],
  ["/signup/teacher", "Sign up as a teacher"],
  ["/login", "Log in"],
  ["/login/forgot", "Reset your password"],
  ["/complete-profile", "Finish setting up your account"],
  ["/smartboard-demo", "SmartBoard demo"],
  ["/student", "Home"],
  ["/student/join", "Join a course"],
  ["/student/courses", "Your courses"],
  ["/student/courses/:courseId", "Course"],
  ["/student/courses/:courseId/materials/:materialId", "Course material"],
  ["/student/courses/:courseId/assignments/:assignmentId", "Assignment"],
  ["/student/courses/:courseId/assignments/:assignmentId/coach", "AI coach"],
  ["/student/courses/:courseId/assignments/:assignmentId/verify", "Check your understanding"],
  ["/student/settings", "Settings"],
  ["/teacher", "Dashboard"],
  ["/teacher/students/:studentId", "Student"],
  ["/teacher/courses", "Courses"],
  ["/teacher/courses/new", "Create a course"],
  ["/teacher/courses/:courseId", "Course"],
  ["/teacher/courses/:courseId/assignments/new", "New assignment"],
  ["/teacher/courses/:courseId/materials/new", "Upload material"],
  ["/teacher/courses/:courseId/assignments/:assignmentId", "Assignment"],
  ["/teacher/courses/:courseId/assignments/:assignmentId/submissions/:studentId", "Review submission"],
  ["/teacher/courses/:courseId/materials/:materialId", "Course material"],
  ["/teacher/settings", "Settings"],
]

export function titleFor(pathname: string): string {
  const hit = TITLES.find(([pattern]) => matchPath({ path: pattern, end: true }, pathname))
  return hit ? `${hit[1]} · SocratiQ` : "Page not found · SocratiQ"
}
