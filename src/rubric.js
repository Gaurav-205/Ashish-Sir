'use strict';
// Section 5, 6 & 7 of the requirement: Technical 30 + HR 20 = 50 overall.
const RUBRIC = {
  technical: {
    label: 'Technical Interview',
    total: 30,
    criteria: [
      { key: 'resume_marks',  label: 'Resume Readiness', max: 10 },
      { key: 'project_marks', label: 'Project Defence',  max: 10 },
      { key: 'dsa_marks',     label: 'DSA',              max: 10 },
    ],
  },
  hr: {
    label: 'HR Interview',
    total: 20,
    criteria: [
      { key: 'behaviour_marks', label: 'Behavioural Skills',      max: 10 },
      { key: 'hr_perf_marks',   label: 'HR Interview Performance', max: 10 },
    ],
  },
};
const GRAND_TOTAL = RUBRIC.technical.total + RUBRIC.hr.total; // 50

function grade(pct) {
  if (pct >= 85) return { label: 'Outstanding', cls: 'g-a' };
  if (pct >= 70) return { label: 'Good',        cls: 'g-b' };
  if (pct >= 55) return { label: 'Average',     cls: 'g-c' };
  if (pct >= 40) return { label: 'Needs Work',  cls: 'g-d' };
  return { label: 'Poor', cls: 'g-e' };
}
module.exports = { RUBRIC, GRAND_TOTAL, grade };
