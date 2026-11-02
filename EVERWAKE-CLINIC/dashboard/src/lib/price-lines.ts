// A price list pasted as lines ("تنضيف جير 600", "زرعة 12000 - 18000", "تقويم شفاف بعد الكشف") read
// without AI: the name, the price shape and the unit. The AI import (with OPENAI_API_KEY) reads PDFs,
// photos and messier lists; this keeps a pasted list working without it.
export interface ImportItem {
  name_ar: string; name_en?: string | null; category?: string; price?: number | null; price_max?: number | null;
  price_kind?: 'fixed' | 'range' | 'from' | 'after_exam' | 'free'; unit?: string; duration?: number | null; sessions?: number | null; description_ar?: string | null;
}

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const toLatin = (s: string) => s.replace(/[٠-٩]/g, d => String(AR_DIGITS.indexOf(d))).replace(/[٫]/g, '.').replace(/[،]/g, ',');

export function parsePriceLines(text: string): ImportItem[] {
  const out: ImportItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = toLatin(raw).replace(/[•▪◦*·|\t]+/g, ' ').trim();
    if (!line || line.length < 2) continue;
    // 12,000 → 12000 ; 12 ألف → 12000
    line = line.replace(/(\d),(\d{3})\b/g, '$1$2').replace(/(\d+(?:\.\d+)?)\s*(?:ألف|الف|k\b)/gi, (_, n) => String(Math.round(Number(n) * 1000)));
    const nums = [...line.matchAll(/\d+(?:\.\d+)?/g)].map(m => Number(m[0])).filter(n => n >= 10);
    const low = line.toLowerCase();
    let kind: ImportItem['price_kind'] = 'fixed';
    if (/بعد الكشف|حسب الحال|after (the )?(exam|check)/i.test(low)) kind = 'after_exam';
    else if (/مجان|ببلاش|free/i.test(low)) kind = 'free';
    else if (nums.length >= 2) kind = 'range';
    else if (/(^|\s)(من|يبدأ|تبدأ|from|starting)(\s|$)/i.test(low)) kind = 'from';
    const unit = /لل?سن(ه|ة)|للضرس|per tooth|\/tooth/i.test(low) ? 'tooth' : /للقنا(ه|ة)|per canal/i.test(low) ? 'canal'
      : /للفك|per jaw/i.test(low) ? 'jaw' : /للجلس(ه|ة)|per session/i.test(low) ? 'session' : /للمنطق(ه|ة)|per area/i.test(low) ? 'area' : 'visit';
    const name = line
      .replace(/\d+(?:\.\d+)?/g, ' ')
      .replace(/(?<=^|\s)(جنيه|جنية|ج\.م|ج\.?|egp|le|l\.e\.?|pounds?)(?=\s|$)/gi, ' ')
      .replace(/بعد الكشف|حسب الحال(ه|ة)|مجان(ا|اً|ي)?|(^|\s)(من|الى|إلى|لـ?|to|from|starting|يبدأ|تبدأ)(?=\s|$)/gi, ' ')
      .replace(/لل?سن(ه|ة)|للضرس|للقنا(ه|ة)|للفك|للجلس(ه|ة)|للمنطق(ه|ة)|per (tooth|canal|jaw|session|area)/gi, ' ')
      .replace(/[:\-–—=()]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name || (!nums.length && kind === 'fixed')) continue;
    const arabic = /[؀-ۿ]/.test(name);
    out.push({ name_ar: name, name_en: arabic ? null : name, price_kind: kind, unit,
               price: kind === 'after_exam' || kind === 'free' ? null : nums[0] ?? null, price_max: kind === 'range' ? nums[1] ?? null : null });
  }
  return out;
}
