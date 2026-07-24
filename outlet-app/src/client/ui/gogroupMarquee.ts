// Letreiro institucional "gogroup" — só aparece nas telas pré-autenticação
// (login, recuperação de senha, boot/carregamento inicial). Nunca dentro do
// app autenticado (ver shell.ts, que não usa este componente).
//
// A imagem original (public/brand/gogroup-banner.png, 1128x191px) é larga,
// mas não larga o suficiente pra cobrir uma tela ultrawide sem repetir —
// por isso cada "metade" da trilha já vem com várias cópias lado a lado
// (COPIES_PER_GROUP), garantindo que uma metade sozinha sempre seja mais
// larga que qualquer viewport real antes de aplicar o loop de -50%.
const COPIES_PER_GROUP = 8;

function imgTag(isFirstVisible: boolean): string {
  return isFirstVisible
    ? `<img src="/brand/gogroup-banner.png" alt="GoGroup" />`
    : `<img src="/brand/gogroup-banner.png" alt="" aria-hidden="true" />`;
}

function trackGroup(includeVisibleAlt: boolean): string {
  return `<div class="gogroup-group">${Array.from({ length: COPIES_PER_GROUP }, (_, i) => imgTag(includeVisibleAlt && i === 0)).join("")}</div>`;
}

export function goGroupMarqueeHtml(): string {
  return `
    <div class="gogroup-marquee" aria-hidden="false">
      <div class="gogroup-track">
        ${trackGroup(true)}
        ${trackGroup(false)}
      </div>
    </div>`;
}
