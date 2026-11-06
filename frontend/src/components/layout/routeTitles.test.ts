import { describe, expect, it } from "vitest"
import { titleFor } from "./routeTitles"

describe("titleFor", () => {
  it("gives each route its own title", () => {
    expect(titleFor("/login")).toBe("Log in · SocratiQ")
    expect(titleFor("/teacher")).toBe("Dashboard · SocratiQ")
    expect(titleFor("/student/courses/abc/assignments/xyz/coach")).toBe("AI coach · SocratiQ")
  })
  it("prefers the specific pattern over a parameterised one", () => {
    expect(titleFor("/teacher/courses/new")).toBe("Create a course · SocratiQ")
    expect(titleFor("/teacher/courses/c1")).toBe("Course · SocratiQ")
    expect(titleFor("/teacher/courses/c1/assignments/new")).toBe("New assignment · SocratiQ")
  })
  it("labels unknown routes", () => {
    expect(titleFor("/nope")).toBe("Page not found · SocratiQ")
  })
})
