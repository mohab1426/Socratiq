import { Routes, Route } from "react-router-dom"
import Landing from "@/pages/Landing"
import ChooseSignup from "@/pages/auth/ChooseSignup"
import SignupStudent from "@/pages/auth/SignupStudent"
import SignupTeacher from "@/pages/auth/SignupTeacher"
import Login from "@/pages/auth/Login"
import ForgotPassword from "@/pages/auth/ForgotPassword"
import Settings from "@/pages/Settings"
import NotFound from "@/pages/NotFound"
import CompleteProfile from "@/pages/auth/CompleteProfile"
import { RequireAuth } from "@/lib/auth"
import { RouteTitle } from "@/components/layout/RouteTitle"

import StudentHome from "@/pages/student/Home"
import StudentCourses from "@/pages/student/Courses"
import StudentCourseDetail from "@/pages/student/CourseDetail"
import StudentMaterialDetail from "@/pages/student/MaterialDetail"
import StudentAssignmentDetail from "@/pages/student/AssignmentDetail"
import AiCoach from "@/pages/student/AiCoach"
import Verification from "@/pages/student/Verification"
import JoinCourse from "@/pages/student/JoinCourse"

import TeacherDashboard from "@/pages/teacher/Dashboard"
import StudentDetail from "@/pages/teacher/StudentDetail"
import TeacherCourses from "@/pages/teacher/Courses"
import TeacherCourseDetail from "@/pages/teacher/CourseDetail"
import TeacherAssignmentDetail from "@/pages/teacher/AssignmentDetail"
import TeacherMaterialDetail from "@/pages/teacher/MaterialDetail"
import CreateCourse from "@/pages/teacher/CreateCourse"
import NewAssignment from "@/pages/teacher/NewAssignment"
import UploadMaterial from "@/pages/teacher/UploadMaterial"
import SubmissionReview from "@/pages/teacher/SubmissionReview"
import SmartBoardDemo from "@/pages/SmartBoardDemo"

export default function App() {
  return (
    <>
    <RouteTitle />
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/smartboard-demo" element={<SmartBoardDemo />} />
      <Route path="/signup" element={<ChooseSignup />} />
      <Route path="/signup/student" element={<SignupStudent />} />
      <Route path="/signup/teacher" element={<SignupTeacher />} />
      <Route path="/login" element={<Login />} />
      <Route path="/login/forgot" element={<ForgotPassword />} />
      <Route path="/complete-profile" element={<CompleteProfile />} />

      <Route path="/student" element={<RequireAuth role="student"><StudentHome /></RequireAuth>} />
      <Route path="/student/join" element={<RequireAuth role="student"><JoinCourse /></RequireAuth>} />
      <Route path="/student/courses" element={<RequireAuth role="student"><StudentCourses /></RequireAuth>} />
      <Route path="/student/courses/:courseId" element={<RequireAuth role="student"><StudentCourseDetail /></RequireAuth>} />
      <Route path="/student/courses/:courseId/materials/:materialId" element={<RequireAuth role="student"><StudentMaterialDetail /></RequireAuth>} />
      <Route path="/student/courses/:courseId/assignments/:assignmentId" element={<RequireAuth role="student"><StudentAssignmentDetail /></RequireAuth>} />
      <Route path="/student/courses/:courseId/assignments/:assignmentId/coach" element={<RequireAuth role="student"><AiCoach /></RequireAuth>} />
      <Route path="/student/courses/:courseId/assignments/:assignmentId/verify" element={<RequireAuth role="student"><Verification /></RequireAuth>} />
      <Route path="/student/settings" element={<RequireAuth role="student"><Settings role="student" /></RequireAuth>} />

      <Route path="/teacher" element={<RequireAuth role="teacher"><TeacherDashboard /></RequireAuth>} />
      <Route path="/teacher/students/:studentId" element={<RequireAuth role="teacher"><StudentDetail /></RequireAuth>} />
      <Route path="/teacher/courses" element={<RequireAuth role="teacher"><TeacherCourses /></RequireAuth>} />
      <Route path="/teacher/courses/new" element={<RequireAuth role="teacher"><CreateCourse /></RequireAuth>} />
      <Route path="/teacher/courses/:courseId" element={<RequireAuth role="teacher"><TeacherCourseDetail /></RequireAuth>} />
      <Route path="/teacher/courses/:courseId/assignments/new" element={<RequireAuth role="teacher"><NewAssignment /></RequireAuth>} />
      <Route path="/teacher/courses/:courseId/materials/new" element={<RequireAuth role="teacher"><UploadMaterial /></RequireAuth>} />
      <Route path="/teacher/courses/:courseId/assignments/:assignmentId" element={<RequireAuth role="teacher"><TeacherAssignmentDetail /></RequireAuth>} />
      <Route path="/teacher/courses/:courseId/assignments/:assignmentId/submissions/:studentId" element={<RequireAuth role="teacher"><SubmissionReview /></RequireAuth>} />
      <Route path="/teacher/courses/:courseId/materials/:materialId" element={<RequireAuth role="teacher"><TeacherMaterialDetail /></RequireAuth>} />
      <Route path="/teacher/settings" element={<RequireAuth role="teacher"><Settings role="teacher" /></RequireAuth>} />

      <Route path="*" element={<NotFound />} />
    </Routes>
    </>
  )
}
