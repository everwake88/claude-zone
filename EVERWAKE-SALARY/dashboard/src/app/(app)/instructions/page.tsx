import { getT } from '@/lib/auth';
import type { Key } from '@/lib/i18n';
import { loadInstructions } from '@/lib/instructions';
import { PageHeader } from '@/components/PageHeader';
import { InstructionsScreen } from '@/components/InstructionsForms';

// What the assistant is told before every reply: HR reads it, changes it, and goes back if a change did not work.
export default async function Instructions() {
  const { t, lang } = await getT();
  const data = await loadInstructions(lang);
  const keys = ['editorTitle', 'liveSince', 'editor', 'editorSub', 'unsaved', 'chars', 'note', 'notePh', 'save', 'saving', 'undo', 'shortcut',
                'privacy', 'reads', 'readsSub', 'words', 'wordsSub', 'wordCount', 'never', 'remove', 'dontSay', 'avoidPh', 'sayInstead',
                'sayPh', 'sayHint', 'add', 'noWords', 'history', 'historySub', 'current', 'original', 'restoredFrom', 'restore', 'view',
                'backToOriginal', 'discard'];
  const w = { ...Object.fromEntries(keys.map((k) => [k, t(`in.${k}` as Key)])), locale: lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB' };
  return (
    <div className="page">
      <PageHeader title={t('in.title')} sub={t('in.sub')} live={<span className="live"><i />{t('in.live')}</span>} />
      <InstructionsScreen initial={data} w={w} rtl={lang === 'ar'} />
    </div>
  );
}
