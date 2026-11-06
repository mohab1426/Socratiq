// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

afterEach(cleanup)
import { RichText } from "./RichText"
import { looksLikeCode } from "@/lib/richText"

describe("RichText", () => {
  it("renders inline code without the backticks", () => {
    render(<RichText text="Check `i` and `arr`." />)
    expect(screen.getByText("i").tagName).toBe("CODE")
    expect(document.body.textContent).not.toContain("`")
  })
  it("renders fenced blocks as pre/code", () => {
    const { container } = render(<RichText text={"Try:\n```py\nx = 1\n```\nthen run it"} />)
    expect(container.querySelector("pre code")?.textContent).toBe("x = 1")
    expect(container.textContent).toContain("then run it")
  })
  it("never turns markup into elements", () => {
    const { container } = render(<RichText text={'<img src=x onerror=alert(1)> <b>hi</b>'} />)
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("b")).toBeNull()
  })
  it("detects pasted indented code only", () => {
    expect(looksLikeCode("def f():\n    return 1")).toBe(true)
    expect(looksLikeCode("just a sentence\nand another")).toBe(false)
  })
})
