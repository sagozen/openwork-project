import type { ReactNode } from "react";

/** The narrow, centred card every sign-in step sits in. */
export default function AuthCard({
  eyebrow,
  title,
  intro,
  children,
  footer,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  intro?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <p className="eyebrow">{eyebrow}</p>
        <h1 id="auth-title">{title}</h1>
        {intro && <p className="muted">{intro}</p>}
        {children}
        {footer && <div className="auth-footer">{footer}</div>}
      </section>
    </div>
  );
}
