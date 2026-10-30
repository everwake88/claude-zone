// a weight the way it is said at the counter: ربع كيلو، نص كيلو، كيلو ونص
export const kgText = (q: number, lang: 'ar' | 'en') => lang === 'en' ? `${q} kg`
  : q === 0.25 ? 'ربع كيلو' : q === 0.5 ? 'نص كيلو' : q === 0.75 ? 'تلت ارباع كيلو' : q === 1 ? 'كيلو' : q === 1.5 ? 'كيلو ونص' : `${q} كيلو`;
