const logoOnLight = new URL("../images/CodeNomad-Logo-OnLight.svg", import.meta.url).href
const logoOnDark = new URL("../images/CodeNomad-Logo-OnDark.svg", import.meta.url).href

/**
 * The CodeNomad hexagon: black on light palettes, white on dark ones. The palette's
 * appearance picks the image in CSS (styles/components/brand-logo.css), so the logo
 * also works outside ThemeProvider. Size it with a height class on the logo.
 */
export function BrandLogo(props: { alt: string; class?: string }) {
  return (
    <span class={`brand-logo ${props.class ?? ""}`} role="img" aria-label={props.alt}>
      <img class="brand-logo-on-light" src={logoOnLight} alt="" draggable={false} />
      <img class="brand-logo-on-dark" src={logoOnDark} alt="" draggable={false} />
    </span>
  )
}
