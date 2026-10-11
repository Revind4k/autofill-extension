/* Copy this file to src/profile.ts and fill it in. profile.ts is gitignored.
 *
 * Nothing here is sent anywhere by the rule-based pass: these values are written
 * straight onto form fields in the browser. The separate prose profile in the options
 * page is the only thing the Claude API ever sees. */
import type { Profile } from './types.js';

export const profile: Profile = {
  firstName: 'Ada',
  middleName: '',
  lastName: 'Lovelace',
  fullName: 'Ada Lovelace',
  preferredName: 'Ada',

  email: 'ada@example.edu',
  altEmail: 'ada@example.com',
  phone: '(555) 010-0100',
  phoneDigits: '5550100100',

  address1: '1 Example Street',
  city: 'Princeton',
  state: 'NJ',
  stateFull: 'New Jersey',
  zip: '08540',
  country: 'United States',

  linkedin: 'https://www.linkedin.com/in/example/',
  github: 'https://github.com/example',
  website: 'https://example.com',

  school: 'Example University',
  degree: 'Bachelor of Science',
  major: 'Computer Science',
  gpa: '3.80',
  eduStart: '08/2023',
  gradDate: '05/2027',
  coursework: 'Data Structures, Algorithms, Operating Systems',

  company1: 'Example Corp',
  title1: 'Software Engineering Intern',
  loc1: 'Remote',
  start1: '05/2026',
  end1: '09/2026',

  skills: 'TypeScript, Python, Go',
  availability: 'Available immediately',
  salary: 'Negotiable',
  relocate: 'Yes',

  authorized: 'Yes',
  sponsorship: 'No',
  citizenship: 'U.S. Citizen',
  veteran: 'I am not a protected veteran',

  /* Blank on purpose. These are yours to decide; an empty string leaves the field for
   * a human rather than guessing. */
  gender: '',
  ethnicity: '',
  disability: '',
};

/* The prose profile the Claude API reads. Seeds the options textarea on first run.
 *
 * Unlike the structured `profile` above, this is free text, and it is the only thing
 * sent to the API. Write it as a recruiter-readable summary: education, work
 * authorization, availability, experience, projects, skills, links, and an explicit
 * list of what is NOT in the profile so the model returns null instead of guessing. */
export const defaultProfileText = `Name: Ada Lovelace
Email: ada@example.edu
Phone: (555) 010-0100

EDUCATION
Example University, B.S. Computer Science, Aug 2023 to May 2027 (senior). GPA 3.80.

WORK AUTHORIZATION
U.S. citizen. Authorized to work in the U.S. now and in the future. Does NOT require
visa sponsorship, ever. No security clearance.

AVAILABILITY
Available to start immediately.

EXPERIENCE
Software Engineering Intern, Example Corp, remote, May 2026 to Sep 2026.
Describe real work here: what you built, which technologies, what shipped.

PROJECTS
Describe real projects here, with links.

SKILLS
Languages: TypeScript, Python, Go

LINKS
GitHub: https://github.com/example

NOT IN THIS PROFILE, return null rather than guessing: references and their contact
details, exact prior salaries, criminal history, demographic self-identification
(gender, race, disability, veteran status), a driver's licence number, and any
employer, credential or technology not listed above.`;
