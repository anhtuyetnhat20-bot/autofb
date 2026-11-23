// AUTOFB Reel kit (HyperFrames): chuyển cảnh, phụ đề chạy theo lời, tiện ích. Mỗi kênh tự định nghĩa màu, chữ, cảnh.
// Dùng: const K = reelKit({ capActive:'#7DE3FF', capInk:'#0A0F2E', flash:'rgba(...)' }); rồi K.tl, K.L(i), K.SC(i).
// Kiểu dựng riêng của từng kênh: phụ đề, chuyển cảnh, lớp hiệu ứng. Server gắn window.__LOOK theo page.
const FONTFACE = `@font-face{font-family:'Inter';font-weight:200;src:url(assets/fonts/inter-latin-200-normal.woff2) format('woff2')}
@font-face{font-family:'Inter';font-weight:700;src:url(assets/fonts/inter-latin-700-normal.woff2) format('woff2')}
@font-face{font-family:'Inter';font-weight:800;src:url(assets/fonts/inter-latin-800-normal.woff2) format('woff2')}
@font-face{font-family:'Playfair Display';font-weight:700;src:url(assets/fonts/playfair-display-latin-700-normal.woff2) format('woff2')}
@font-face{font-family:'Playfair Display';font-style:italic;font-weight:600;src:url(assets/fonts/playfair-display-latin-600-italic.woff2) format('woff2')}
@font-face{font-family:'Fredoka';font-weight:700;src:url(assets/fonts/fredoka-latin-700-normal.woff2) format('woff2')}
@font-face{font-family:'VT323';src:url(assets/fonts/vt323-latin-400-normal.woff2) format('woff2')}`;
const LOOKS = {
  // The Renter Diaries: nhật ký giấy ấm. Phụ đề trên dải giấy, chữ có chân nghiêng, từ đang đọc gạch chân màu đất nung. Lật trang.
  renter: {
    css: `#cap .cl{background:#FFF4E8;border-radius:6px;padding:14px 22px;box-shadow:0 10px 30px rgba(58,38,32,.35);transform:rotate(-1.2deg);gap:2px 10px}
      #cap .cw{font:600 italic 46px/1.2 'Playfair Display',Georgia,serif !important;color:#3A2620 !important;background:none !important;text-shadow:none !important;padding:0 2px !important;
        background-image:linear-gradient(#C8643B,#C8643B) !important;background-repeat:no-repeat !important;background-position:0 92% !important;background-size:0% 6px !important}
      #lookfx{background:radial-gradient(ellipse at 50% 40%,rgba(255,244,232,0) 55%,rgba(58,38,32,.45) 100%),repeating-linear-gradient(0deg,rgba(255,255,255,.025) 0 2px,transparent 2px 4px)}`,
    enter: (tl, el, at) => tl.from(el, { x: 1080, rotation: 4, transformOrigin: '0% 100%', opacity: 0, duration: .6, ease: 'power2.out' }, at),
    exit: (tl, el, at) => tl.to(el, { x: -300, rotation: -3, opacity: 0, duration: .35, ease: 'power1.in' }, at - .35),
    hi: (tl, s, a, b) => { tl.to(s, { backgroundSize: '100% 6px', duration: Math.max(.12, b - a), ease: 'none' }, a); },
    capIn: { opacity: 0, y: 10, rotation: -3 }
  },
  // The $5 Plate: hóa đơn siêu thị. Phụ đề như băng giấy in hóa đơn, chữ đậm in hoa, từ đang đọc nền xanh lá. Cắt cứng kiểu quét mã.
  plate: {
    css: `#cap .cl{background:#FBFBF4;padding:16px 20px 20px;border-radius:2px;box-shadow:0 8px 24px rgba(0,0,0,.35);gap:4px 10px;
        -webkit-mask:radial-gradient(circle 7px at 50% 100%,transparent 98%,#000) 0 0/22px 100%;mask:radial-gradient(circle 7px at 50% 100%,transparent 98%,#000) 0 0/22px 100%}
      #cap .cw{font:800 40px/1.15 'Inter',Arial,sans-serif !important;text-transform:uppercase;letter-spacing:.5px;color:#0F2A1D !important;text-shadow:none !important;border-radius:3px !important;padding:2px 6px !important}
      #lookfx{background:repeating-linear-gradient(90deg,rgba(255,210,63,.05) 0 1px,transparent 1px 54px),linear-gradient(180deg,transparent 80%,rgba(0,0,0,.35))}`,
    enter: (tl, el, at) => { tl.fromTo(el, { clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0% 0)', duration: .32, ease: 'steps(8)' }, at); },
    exit: (tl, el, at) => tl.to(el, { opacity: 0, duration: .06 }, at - .06),
    hi: (tl, s, a, b) => { tl.to(s, { backgroundColor: '#2FBF71', color: '#FFFFFF', duration: .04 }, a); tl.to(s, { backgroundColor: 'rgba(0,0,0,0)', color: '#0F2A1D', duration: .08 }, b); },
    capIn: { opacity: 0, y: -24 }, ink: '#0F2A1D'
  },
  // Apartment Dog Life: vui, tròn, nảy. Phụ đề bong bóng tròn chữ Fredoka, từ đang đọc nảy lên nền vàng. Cảnh vào bằng bật nảy.
  dog: {
    css: `#cap .cl{gap:6px 10px}
      #cap .cw{font:700 50px/1.1 'Fredoka',Arial,sans-serif !important;color:#12213A !important;background:#FFFFFF !important;border-radius:999px !important;padding:6px 18px !important;text-shadow:none !important;box-shadow:0 6px 0 rgba(18,33,58,.35)}
      #lookfx{background:radial-gradient(circle at 15% 85%,rgba(255,138,61,.18) 0 120px,transparent 121px),radial-gradient(circle at 88% 12%,rgba(255,209,102,.16) 0 90px,transparent 91px)}`,
    enter: (tl, el, at) => tl.from(el, { scale: .55, y: 120, opacity: 0, duration: .7, ease: 'back.out(2.2)', transformOrigin: '50% 60%' }, at),
    exit: (tl, el, at) => tl.to(el, { scale: .8, y: 80, opacity: 0, duration: .25, ease: 'back.in(2)' }, at - .25),
    hi: (tl, s, a, b) => { tl.to(s, { backgroundColor: '#FFD166', scale: 1.14, y: -6, duration: .12, ease: 'back.out(3)' }, a); tl.to(s, { backgroundColor: '#FFFFFF', scale: 1, y: 0, duration: .12 }, b); },
    capIn: { opacity: 0, scale: .6 }
  },
  // Walking Pad Life: công nghệ, kính mờ. Phụ đề thẻ kính, chữ mảnh, từ đang đọc chuyển đậm màu cyan. Cảnh trượt lên mượt.
  walkpad: {
    css: `#cap .cl{background:rgba(20,27,87,.55);border:1px solid rgba(125,227,255,.35);border-radius:22px;padding:16px 22px;box-shadow:0 20px 50px rgba(0,0,0,.35);gap:4px 12px}
      #cap .cw{font:200 46px/1.15 'Inter',Arial,sans-serif !important;color:#E8ECFF !important;background:none !important;text-shadow:none !important;padding:0 !important}
      #lookfx{background:linear-gradient(rgba(125,227,255,.06) 1px,transparent 1px) 0 0/90px 90px,linear-gradient(90deg,rgba(125,227,255,.06) 1px,transparent 1px) 0 0/90px 90px}`,
    enter: (tl, el, at) => tl.from(el, { y: 700, opacity: 0, filter: 'blur(14px)', duration: .55, ease: 'expo.out' }, at),
    exit: (tl, el, at) => tl.to(el, { y: -500, opacity: 0, filter: 'blur(14px)', duration: .3, ease: 'expo.in' }, at - .3),
    hi: (tl, s, a, b) => { tl.to(s, { color: '#7DE3FF', fontWeight: 800, duration: .06 }, a); tl.to(s, { color: '#E8ECFF', fontWeight: 200, duration: .12 }, b); },
    capIn: { opacity: 0, y: 30, filter: 'blur(8px)' }
  },
  // Sweatpants Society: ánh nến, chậm. Phụ đề chữ nghiêng có chân, không khung, từ đang đọc ấm lên màu hổ phách có quầng sáng. Cảnh tan chậm.
  sweatpants: {
    css: `#cap .cl{gap:4px 12px}
      #cap .cw{font:600 italic 50px/1.2 'Playfair Display',Georgia,serif !important;color:rgba(255,236,214,.75) !important;background:none !important;padding:0 2px !important;text-shadow:0 2px 14px rgba(0,0,0,.6) !important}
      #lookfx{background:radial-gradient(ellipse at 50% 35%,rgba(246,178,94,.10) 0,transparent 55%),radial-gradient(ellipse at 50% 50%,transparent 50%,rgba(20,6,26,.65) 100%)}`,
    enter: (tl, el, at) => tl.from(el, { opacity: 0, scale: 1.04, duration: 1.0, ease: 'sine.inOut' }, at - .3),
    exit: (tl, el, at) => tl.to(el, { opacity: 0, duration: .7, ease: 'sine.inOut' }, at - .3),
    hi: (tl, s, a, b) => { tl.to(s, { color: '#F6B25E', textShadow: '0 0 22px rgba(246,178,94,.9)', duration: .2 }, a); tl.to(s, { color: 'rgba(255,236,214,.75)', textShadow: '0 2px 14px rgba(0,0,0,.6)', duration: .4 }, b); },
    capIn: { opacity: 0, y: 6, duration: .5 }
  },
  // Remember When?: màn hình CRT và neon thập niên 80–90. Phụ đề chữ máy tính cũ, từ đang đọc hồng neon. Chuyển cảnh nhiễu sóng.
  remember: {
    css: `#cap .cl{background:rgba(5,2,20,.75);border:2px solid #3EF0FF;padding:12px 20px;gap:2px 14px;box-shadow:0 0 24px rgba(62,240,255,.45)}
      #cap .cw{font:400 60px/1 'VT323',monospace !important;text-transform:uppercase;color:#3EF0FF !important;background:none !important;padding:0 !important;text-shadow:0 0 10px rgba(62,240,255,.8) !important}
      #lookfx{background:repeating-linear-gradient(0deg,rgba(0,0,0,.22) 0 2px,transparent 2px 5px),radial-gradient(ellipse at 50% 50%,transparent 60%,rgba(0,0,0,.55) 100%)}`,
    enter: (tl, el, at) => { tl.from(el, { opacity: 0, duration: .05 }, at); [[-30, .7], [24, .35], [-12, .8], [0, 1]].forEach(([x, o], k) => tl.set(el, { x, opacity: o, filter: k < 3 ? 'hue-rotate(90deg) saturate(2)' : 'none' }, at + .05 + k * .06)); },
    exit: (tl, el, at) => { tl.set(el, { x: 20, filter: 'hue-rotate(-90deg)' }, at - .12); tl.to(el, { opacity: 0, scaleY: .02, duration: .1 }, at - .1); },
    hi: (tl, s, a, b) => { tl.set(s, { color: '#FF3EA5', textShadow: '0 0 14px rgba(255,62,165,.95)' }, a); tl.set(s, { color: '#3EF0FF', textShadow: '0 0 10px rgba(62,240,255,.8)' }, b); },
    capIn: { opacity: 0 }
  }
};

function reelKit(o) {
  const D = JSON.parse(document.getElementById('timing').textContent);
  const $ = s => document.querySelector(s);
  const tl = gsap.timeline({ paused: true }), E = 'power3.out';
  const ENTER = o.enter || [{}, { x: 240 }, { y: 200 }, { x: -240 }, { scale: 1.2 }, { y: -200 }, { scale: .85 }];
  const LK = LOOKS[o.look || window.__LOOK] || null;
  if (LK) { const st = document.createElement('style'); st.textContent = FONTFACE + LK.css; document.head.appendChild(st);
    const fx = document.createElement('div'); fx.id = 'lookfx'; fx.style.cssText = 'position:absolute;inset:0;z-index:24;pointer-events:none'; (document.getElementById('root') || document.body).appendChild(fx); }
  D.scenes.forEach((sc, i) => {
    const el = document.getElementById('s' + sc.id), d = sc.end - sc.start; if (!el) return;
    tl.fromTo(el, { scale: 1 }, { scale: 1.05, duration: d, ease: 'none', transformOrigin: '50% 40%' }, sc.start);
    if (LK) { if (i) LK.enter(tl, el, sc.start); if (i < D.scenes.length - 1) LK.exit(tl, el, sc.end); return; }
    if (i) tl.from(el, { ...ENTER[i % ENTER.length], opacity: 0, duration: .45, ease: E }, sc.start);
    if (i < D.scenes.length - 1) tl.to(el, { opacity: 0, filter: 'blur(10px)', duration: .25, ease: 'power1.in' }, sc.end - .25);
    if (i && $('#flash')) { tl.fromTo('#flash', { opacity: 0, x: -1100 }, { opacity: .9, x: 0, duration: .22, ease: 'power2.in' }, sc.start - .2); tl.to('#flash', { opacity: 0, x: 1100, duration: .25, ease: 'power2.out' }, sc.start + .02); }
  });
  const cap = $('#cap');
  D.lines.forEach((ln, li) => {
    const el = document.createElement('div'); el.className = 'cl';
    ln.words.forEach(w => { const s = document.createElement('span'); s.className = 'cw'; s.textContent = w[0]; el.appendChild(s); }); cap.appendChild(el);
    const next = D.lines[li + 1], off = next && next.start - ln.end < .6 ? next.start - .02 : ln.end + .35;
    if (LK) { const ci = LK.capIn || { opacity: 0, y: 16 }, cd = ci.duration || .18, to = { opacity: 1, duration: cd, ease: E }; for (const k in ci) if (k !== 'opacity' && k !== 'duration') to[k] = k === 'filter' ? 'blur(0px)' : k === 'scale' ? 1 : 0;
      const from = { ...ci }; delete from.duration; tl.fromTo(el, from, to, ln.start - .08); tl.to(el, { opacity: 0, duration: .1 }, off);
      [...el.children].forEach((s, k) => LK.hi(tl, s, ln.words[k][1], ln.words[k][2])); return; }
    tl.fromTo(el, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: .15, ease: E }, ln.start - .08); tl.to(el, { opacity: 0, duration: .1 }, off);
    [...el.children].forEach((s, k) => { tl.to(s, { color: o.capInk, backgroundColor: o.capActive, duration: .07 }, ln.words[k][1]); tl.to(s, { color: '#FFFFFF', backgroundColor: 'rgba(0,0,0,0)', duration: .1 }, ln.words[k][2]); });
  });
  const svg = (tag, attrs, parent) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
  const count = (el, from, to, at, dur, fmt) => { const v = { n: from }; tl.to(v, { n: to, duration: dur, ease: 'none', onUpdate: () => { el.textContent = fmt(v.n); } }, at); };
  const done = () => { window.__timelines = window.__timelines || {}; window.__timelines['main'] = tl; tl.seek(0); };
  // Editor đôi khi đếm câu từ 0 (L(0)): tự nhận ra, và kẹp chỉ số để không làm hỏng cả video.
  const base = /\bL\(\s*0\s*\)/.test([...document.scripts].map(x => x.textContent).join('\n')) ? 0 : 1;
  const pick = (arr, i) => arr[Math.min(Math.max(i - base, 0), arr.length - 1)];
  const sbase = /\bSC\(\s*0\s*\)/.test([...document.scripts].map(x => x.textContent).join('\n')) ? 0 : 1;
  return { D, tl, E, $, L: i => pick(D.lines, i).start, SC: i => D.scenes[Math.min(Math.max(i - sbase, 0), D.scenes.length - 1)], svg, count, done };
}
