import React from "react"
export const MathView = ({ latex }: any) => <span>{latex}</span>
export const TextNode = ({ text }: any) => <span>{text}</span>
export const SimulationNode = () => <div />
export const cn = (...a: any[]) => a.flat(Infinity).filter(Boolean).join(" ")
const icon = () => <span />
export const Sparkles = icon, Loader2 = icon
