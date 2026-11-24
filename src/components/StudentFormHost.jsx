// The student form (new or edit) lives here, above the pages, so it can be minimized: the user can open
// another page (e.g. to check the groups) and come back to the form with everything typed so far.
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Maximize2, UserRound, X } from 'lucide-react';
import { useT } from '../i18n';
import { Button, useConfirm, useToast } from './ui';
import { StudentForm } from '../pages/Students';

const Ctx = createContext(null);
export const useStudentForm = () => useContext(Ctx);

export function StudentFormHost({ children }) {
  const t = useT();
  const confirm = useConfirm();
  const toast = useToast();
  const [form, setForm] = useState(null); // { student, onSaved, key }
  const [minimized, setMinimized] = useState(false);
  const [draft, setDraft] = useState('');
  const seq = useRef(0);

  // One form at a time: asking for another while one is open brings the open one back.
  const open = useCallback(
    (student = {}, opts = {}) => {
      setForm((cur) => {
        if (cur) {
          toast.error(t('studentForm.alreadyOpen'));
          return cur;
        }
        seq.current += 1;
        setDraft('');
        return { student, onSaved: opts.onSaved, key: seq.current };
      });
      setMinimized(false);
    },
    [t, toast]
  );
  const close = () => {
    setForm(null);
    setMinimized(false);
  };
  const discard = async () => {
    if (await confirm({ title: t('studentForm.discardTitle'), text: t('studentForm.discardText'), confirmLabel: t('studentForm.discard') })) close();
  };
  const api = useMemo(() => ({ open }), [open]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {form && (
        <StudentForm
          key={form.key}
          student={form.student}
          minimized={minimized}
          onMinimize={() => setMinimized(true)}
          onDraft={setDraft}
          onClose={close}
          onSaved={(id) => {
            const done = form.onSaved;
            close();
            done?.(id);
          }}
        />
      )}
      {form && minimized && (
        <div className="form-chip">
          <UserRound size={17} />
          <div className="grow">
            <div className="strong">{t(form.student.id ? 'studentForm.editing' : 'studentForm.new')}</div>
            <div className="small muted">{draft || t('studentForm.noName')}</div>
          </div>
          <Button size="sm" variant="primary" icon={Maximize2} onClick={() => setMinimized(false)}>
            {t('studentForm.restore')}
          </Button>
          <Button size="sm" variant="ghost" icon={X} onClick={discard} aria-label={t('studentForm.discard')} title={t('studentForm.discard')} />
        </div>
      )}
    </Ctx.Provider>
  );
}
