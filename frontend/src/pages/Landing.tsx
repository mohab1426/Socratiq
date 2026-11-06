import { useEffect, type ReactNode } from "react"
import { useLocation } from "react-router-dom"
import { ArrowDown, ArrowRight, BookOpen, ClipboardList, Eye, FileText, GraduationCap, LayoutDashboard, MessageCircle, RefreshCw, ShieldCheck, Users } from "lucide-react"
import { PublicHeader } from "@/components/layout/PublicHeader"
import { PublicFooter } from "@/components/layout/PublicFooter"
import { ProductPreviews } from "@/components/landing/ProductPreviews"
import { ButtonLink } from "@/components/ui/Button"
import { Reveal } from "@/components/ui/Reveal"
import { useInView } from "@/lib/useInView"
import { cn } from "@/lib/utils"

/* ------------------------------------------------------------------ content */

const floatCards = [
  { tag: "The old way", body: "Paste the question. Get the answer. Learn nothing.", className: "bg-white", tilt: "2deg", delay: "0ms" },
  { tag: "SocratiQ", body: "Asks the next question instead of handing you the last one.", className: "bg-[var(--color-teal)]", tilt: "-2deg", delay: "900ms" },
  { tag: "Result", body: "Real understanding, visible to your teacher.", className: "bg-[var(--color-clay-light)]", tilt: "3deg", delay: "1800ms" },
]

type Actor = "Teacher" | "Student" | "AI Coach"
const actorStyle: Record<Actor, string> = {
  Teacher: "bg-[var(--color-slate-light)] text-[var(--color-ink)]",
  Student: "bg-[var(--color-teal-light)] text-[var(--color-teal-dark)]",
  "AI Coach": "bg-[var(--color-plum-light)] text-[var(--color-ink)]",
}

const steps: { actor: Actor; title: string; body: string }[] = [
  { actor: "Teacher", title: "Sets up the course", body: "Creates an assignment and uploads the readings and slides students will work from." },
  { actor: "Student", title: "Works with the AI Coach", body: "Starts the assignment and explains where they're stuck, with the course material in reach." },
  { actor: "AI Coach", title: "Reads the reasoning", body: "Looks at what the student tried and where the thinking stalls, using the course material as its source." },
  { actor: "AI Coach", title: "Responds with a nudge", body: "A hint, a question or an explanation sized to the gap, not the finished answer." },
  { actor: "Student", title: "Revises", body: "Applies the nudge, submits, and can open a new attempt to improve the work." },
  { actor: "Student", title: "Shows understanding", body: "A short verification about their own solution: explain it, modify it, then apply it to a new case." },
  { actor: "Teacher", title: "Sees the evidence", body: "Submission, coach activity and verification results sit together, so the process is visible, not just the result." },
]

const studentFeatures = [
  { icon: MessageCircle, title: "An AI Coach that asks", body: "Say where you're stuck. The coach reads your attempt and responds with what to think about next." },
  { icon: Eye, title: "Hints, not answers", body: "Hints, questions and explanations sized to the gap. By default the coach will not hand over a finished answer." },
  { icon: BookOpen, title: "Grounded in your course", body: "Replies draw on the readings and slides your instructor uploaded, and show which document and page they came from." },
  { icon: ClipboardList, title: "Knows the assignment", body: "You work inside the assignment itself, so there is no need to paste the prompt into a separate chat." },
  { icon: RefreshCw, title: "Revise and resubmit", body: "After submitting you can open a new attempt to improve your work, with the coach still available." },
  { icon: ShieldCheck, title: "Verify what you learned", body: "A short conversation about your own solution lets you show the reasoning behind it before it is graded." },
]

const teacherFeatures = [
  { icon: ClipboardList, title: "Assignment management", body: "Write or upload an assignment, set a due date, attach datasets or reference files, and publish when it's ready." },
  { icon: FileText, title: "Course materials", body: "Upload readings, slides and spreadsheets. They are processed so the coach can draw on them." },
  { icon: Users, title: "Classroom visibility", body: "Share an invite code, see who has joined, and see where each student stands on each assignment." },
  { icon: GraduationCap, title: "Student progress", body: "Submission status, coach usage and verified understanding for every student, in one table." },
  { icon: Eye, title: "Learning evidence", body: "Open any submission to see the verification answers and review indicators next to the work itself." },
  { icon: LayoutDashboard, title: "Dashboard and analytics", body: "Completion, activity and mastery charts drawn from your class's own data. Nothing is estimated." },
]

const evidence = [
  { title: "AI assistance", body: "Hints, questions and explanations from a coach that works from your course material." },
  { title: "Learning process", body: "Attempts, revisions and the conversation that led to each change are recorded as they happen." },
  { title: "Learning evidence", body: "A verification in the student's own words, reviewed by the instructor alongside the submission." },
]

/* ------------------------------------------------------------------ helpers */

const container = "mx-auto w-full max-w-6xl px-6 lg:px-10"
const sectionPad = "py-20 lg:py-28"

function SectionIntro({ title, children, tone = "light" }: { title: string; children: ReactNode; tone?: "light" | "dark" }) {
  return (
    <Reveal className="max-w-2xl">
      <h2 className={cn("font-serif text-3xl font-bold leading-[1.15] tracking-[-0.01em] sm:text-[2.6rem]", tone === "dark" ? "text-white" : "text-[var(--color-ink)]")}>{title}</h2>
      <p className={cn("mt-4 text-lg leading-relaxed", tone === "dark" ? "text-[var(--color-canvas)]/85" : "text-[var(--color-ink-muted)]")}>{children}</p>
    </Reveal>
  )
}

function FeatureGrid({ items, chip }: { items: { icon: typeof Eye; title: string; body: string }[]; chip: string }) {
  return (
    <ul className="mt-12 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((f, i) => (
        <Reveal as="li" key={f.title} delay={(i % 3) * 90}>
          <span className={cn("flex h-10 w-10 items-center justify-center rounded-full text-[var(--color-ink)]", chip)}>
            <f.icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <h3 className="mt-4 text-base font-semibold text-[var(--color-ink)]">{f.title}</h3>
          <p className="mt-1.5 text-[0.95rem] leading-relaxed text-[var(--color-ink-muted)]">{f.body}</p>
        </Reveal>
      ))}
    </ul>
  )
}

/* ------------------------------------------------------------------ sections */

function Hero() {
  const rise = (ms: number) => ({ "--rise-delay": `${ms}ms` }) as React.CSSProperties
  return (
    <section className="relative overflow-hidden pb-20 pt-6 lg:pb-24">
      {/* one slow, low-contrast light behind the headline */}
      <div aria-hidden="true" className="drift pointer-events-none absolute -right-40 top-8 h-[560px] w-[560px] rounded-full" style={{ background: "radial-gradient(closest-side, rgba(250,149,0,0.18), rgba(250,149,0,0))" }} />

      <div className={cn(container, "relative")}>
        <div className="relative">
          <h1 className="select-none text-[16vw] font-extrabold leading-[0.82] tracking-tight sm:text-[13vw] lg:text-[9rem]" aria-label="Think first.">
            <span className="rise-in block text-[var(--color-plum)]" style={rise(0)} aria-hidden="true">THINK</span>
            <span className="rise-in block text-transparent" style={{ ...rise(120), WebkitTextStroke: "2px var(--color-ink)" }} aria-hidden="true">FIRST.</span>
          </h1>

          <div className="mt-10 flex flex-col gap-5 sm:flex-row sm:flex-wrap lg:absolute lg:right-0 lg:top-1 lg:mt-0 lg:w-[320px] lg:flex-col lg:gap-6">
            {floatCards.map((c, i) => (
              <div key={c.tag} className="rise-in sm:flex-1 lg:flex-none" style={rise(380 + i * 130)}>
                <div className={cn("float-soft rounded-2xl px-6 py-5 text-[var(--color-ink)] shadow-lg", c.className)} style={{ "--tilt": c.tilt, "--float-delay": c.delay } as React.CSSProperties}>
                  <p className="text-xs font-bold text-[var(--color-ink)]/75">{c.tag}</p>
                  <p className="mt-1.5 text-[15px] font-semibold leading-snug">{c.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rise-in mt-12 max-w-xl lg:mt-14" style={rise(240)}>
          <p className="text-lg leading-relaxed text-[var(--color-ink)] sm:text-xl">
            SocratiQ is an AI learning coach for university courses. It answers a stuck student with the next question, not the finished solution, and it records the reasoning so instructors can see how understanding was built.
          </p>
          <p className="mt-3 text-base text-[var(--color-ink-muted)]">For students who want to learn the material, and instructors who want evidence of it.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink to="/signup" size="lg">Sign up</ButtonLink>
            <ButtonLink to="/login" size="lg" variant="outline">Log in</ButtonLink>
          </div>
        </div>
      </div>
    </section>
  )
}

function HowItWorks() {
  const [ref, seen] = useInView<HTMLOListElement>()
  return (
    <section id="how-it-works" className={cn("scroll-mt-20 bg-white", sectionPad)}>
      <div className={cn(container, "grid gap-12 lg:grid-cols-[5fr_7fr] lg:gap-16")}>
        <div className="lg:sticky lg:top-28 lg:self-start">
          <SectionIntro title="From assignment to evidence in seven steps">
            Everything happens inside the course, so the record of how a student learned doesn't have to be reconstructed afterwards.
          </SectionIntro>
        </div>

        <ol ref={ref} className="relative space-y-7">
          {/* rail: draws itself once the list is on screen */}
          <span aria-hidden="true" className="absolute bottom-3 left-[1.125rem] top-3 w-px origin-top bg-[var(--color-border-strong)] transition-transform duration-[1400ms] ease-out motion-reduce:transition-none" style={{ transform: seen ? "scaleY(1)" : "scaleY(0)" }} />
          {steps.map((s, i) => (
            <Reveal as="li" key={s.title} delay={i * 70} className="relative flex gap-5">
              <span className="relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--color-border-strong)] bg-white text-sm font-semibold text-[var(--color-ink)]">{i + 1}</span>
              <div className="min-w-0 pb-1">
                <span className={cn("inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold", actorStyle[s.actor])}>{s.actor}</span>
                <h3 className="mt-1.5 text-lg font-semibold text-[var(--color-ink)]">{s.title}</h3>
                <p className="mt-1 max-w-md text-[0.95rem] leading-relaxed text-[var(--color-ink-muted)]">{s.body}</p>
              </div>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  )
}

function Students() {
  return (
    <section id="students" className={cn("scroll-mt-20", sectionPad)}>
      <div className={container}>
        <SectionIntro title="Help that builds the skill, not just the submission">
          The coach is designed to guide rather than complete the work, so students still do the thinking and finish knowing why their answer holds.
        </SectionIntro>
        <FeatureGrid items={studentFeatures} chip="bg-white ring-1 ring-[var(--color-border-strong)]" />
      </div>
    </section>
  )
}

function Teachers() {
  return (
    <section id="teachers" className={cn("scroll-mt-20 bg-white", sectionPad)}>
      <div className={container}>
        <SectionIntro title="See how students got there, not only where they ended up">
          Run the course, follow each student's progress, and review the evidence behind a submission in the same place you assign it.
        </SectionIntro>
        <FeatureGrid items={teacherFeatures} chip="bg-[var(--color-plum-light)] ring-1 ring-[var(--color-plum)]/40" />
      </div>
    </section>
  )
}

function Evidence() {
  const [ref, seen] = useInView<HTMLOListElement>()
  return (
    <section id="evidence" className={cn("scroll-mt-20 bg-[var(--color-ink)]", sectionPad)}>
      <div className={container}>
        <SectionIntro tone="dark" title="AI assistance leaves a trail worth reading">
          The point isn't to block AI. It's to make the learning that happens with it something an instructor can actually see.
        </SectionIntro>

        <ol ref={ref} className="mt-14 grid items-stretch gap-3 lg:grid-cols-[1fr_auto_1fr_auto_1fr]">
          {evidence.map((e, i) => (
            <li key={e.title} className="contents">
              <Reveal delay={i * 160} className={cn("rounded-[var(--radius-lg)] border p-6", i === evidence.length - 1 ? "border-[var(--color-plum)]/70 bg-[var(--color-plum)]/10" : "border-white/15 bg-white/[0.05]")}>
                <h3 className="font-serif text-2xl font-bold text-white">{e.title}</h3>
                <p className="mt-2 text-[0.95rem] leading-relaxed text-[var(--color-canvas)]/85">{e.body}</p>
              </Reveal>
              {i < evidence.length - 1 && (
                <span aria-hidden="true" className="flex items-center justify-center text-[var(--color-plum)] transition-opacity duration-700 motion-reduce:transition-none" style={{ opacity: seen ? 1 : 0, transitionDelay: `${i * 160 + 300}ms` }}>
                  <ArrowRight className="hidden h-6 w-6 lg:block" />
                  <ArrowDown className="h-6 w-6 lg:hidden" />
                </span>
              )}
            </li>
          ))}
        </ol>

        <Reveal className="mt-10 max-w-2xl border-l-2 border-[var(--color-plum)] pl-5">
          <p className="text-base leading-relaxed text-[var(--color-canvas)]/90">
            Not a detector. Review indicators are observations worth a second look, never a verdict about a student's intent or about which tools they used.
          </p>
        </Reveal>
      </div>
    </section>
  )
}

function Preview() {
  return (
    <section id="product" className={cn("scroll-mt-20", sectionPad)}>
      <div className={container}>
        <SectionIntro title="A look inside">
          One workspace for students and instructors, in the same visual language on both sides.
        </SectionIntro>
        <div className="mt-12"><ProductPreviews /></div>
      </div>
    </section>
  )
}

function FinalCta() {
  return (
    <section className="bg-[var(--color-plum)] py-20 lg:py-24">
      <Reveal className={cn(container, "flex flex-col items-start justify-between gap-8 lg:flex-row lg:items-center")}>
        <div className="max-w-xl">
          <h2 className="font-serif text-3xl font-bold leading-[1.15] tracking-[-0.01em] text-[var(--color-ink)] sm:text-[2.6rem]">Make the thinking visible.</h2>
          <p className="mt-3 text-lg leading-relaxed text-[var(--color-ink)]/85">Create an account as a student or an instructor and try it on a real assignment.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <ButtonLink to="/signup" size="lg" className="bg-[var(--color-ink)] text-[var(--color-canvas)] hover:bg-[var(--color-ink)]/85">Sign up</ButtonLink>
          <ButtonLink to="/login" size="lg" variant="outline" className="border-[color:var(--color-ink)] bg-transparent text-[var(--color-ink)] hover:bg-white/40">Log in</ButtonLink>
        </div>
      </Reveal>
    </section>
  )
}

/* ------------------------------------------------------------------ page */

export default function Landing() {
  // Links from the footer / other pages arrive as /#section; router doesn't scroll to hashes on its own.
  const { hash, key } = useLocation()
  useEffect(() => {
    if (!hash) return
    const el = document.getElementById(decodeURIComponent(hash.slice(1)))
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: "start" }))
  }, [hash, key])

  return (
    <div className="min-h-screen bg-[var(--color-canvas)]">
      <PublicHeader />
      <main>
        <Hero />
        <HowItWorks />
        <Students />
        <Teachers />
        <Evidence />
        <Preview />
        <FinalCta />
      </main>
      <PublicFooter />
    </div>
  )
}
