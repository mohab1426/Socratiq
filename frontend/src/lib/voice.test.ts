import { describe, expect, it } from "vitest"
import { speakable } from "./voice"

describe("speakable", () => {
  it("removes markdown symbols but keeps the words", () => {
    expect(speakable("**Why** did you subtract `5`?\n\n> think")).toBe("Why did you subtract 5? think")
  })
  it("does not read code blocks aloud", () => {
    expect(speakable("Look:\n```py\nx = 1\n```\nWhat changes?")).toBe("Look: (code omitted) What changes?")
  })
})
