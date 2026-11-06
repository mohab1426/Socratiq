import { useEffect } from "react"
import { useLocation } from "react-router-dom"
import { titleFor } from "./routeTitles"

export function RouteTitle() {
  const { pathname } = useLocation()
  useEffect(() => {
    document.title = titleFor(pathname)
  }, [pathname])
  return null
}
