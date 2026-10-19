/**
 * Rabbit Rabbi Awards — categories and nominees.
 *
 * This is the ONE place to edit categories and nominees.
 *
 * - `people` lists every nominee once. The key is a stable id (lowercase,
 *   no spaces). Add `image: "/img/nominees/<file>"` to give someone a photo, or
 *   simply drop `<id>.jpg|.jpeg|.png|.webp` into public/img/nominees/ and it is
 *   picked up automatically on the next server start.
 * - `categories` lists each award and the people nominated for it, in the
 *   order they should be displayed. Categories may have any number of nominees (2+).
 *
 * IMPORTANT: once voting has started, do not change category ids or person ids.
 * Votes are stored by id. Display names can be changed at any time.
 */

const people = {
  griffin: { name: 'Griffin' },
  sam: { name: 'Sam' },
  josh: { name: 'Josh' },
  stephen: { name: 'Stephen' },
  hawkin: { name: 'Hawkin' },
  gage: { name: 'Gage' },
  ian: { name: 'Ian' },
  quinn: { name: 'Quinn' },
  morgan: { name: 'Morgan' },
  // Duo of the Year nominees (each pair is one nominee)
  'sam-griffin': { name: 'Sam & Griffin' },
  'stephen-josh': { name: 'Stephen & Josh' },
  'hawkin-morgan': { name: 'Hawkin & Morgan' },
  'ian-gage': { name: 'Ian & Gage' },
};

const categories = [
  {
    id: 'most-athletic',
    name: 'Most Athletic',
    blurb: 'Fastest, strongest, most likely to pull something.',
    nominees: ['griffin', 'sam', 'josh', 'stephen', 'hawkin'],
  },
  {
    id: 'best-entrance',
    name: 'Best Entrance',
    blurb: 'Walks in like the room was waiting for them.',
    nominees: ['sam', 'hawkin', 'gage', 'griffin'],
  },
  {
    id: 'most-like-marlon',
    name: 'Most Like Marlon',
    blurb: 'You know exactly what we mean.',
    nominees: ['sam', 'josh', 'gage', 'ian', 'stephen', 'hawkin'],
  },
  {
    id: 'most-reels-scrolled',
    name: 'Most Reels Scrolled',
    blurb: 'Thumb never stops. Screen time is a lifestyle.',
    nominees: ['quinn', 'sam', 'griffin', 'stephen', 'hawkin', 'morgan'],
  },
  {
    id: 'best-gamer',
    name: 'Best Gamer',
    blurb: 'Clutch plays and controller-throwing energy.',
    nominees: ['gage', 'hawkin', 'griffin', 'sam', 'morgan'],
  },
  {
    id: 'driver-of-the-year',
    name: 'Driver of the Year',
    blurb: 'Who do you actually trust behind the wheel?',
    nominees: ['hawkin', 'gage', 'griffin', 'josh', 'stephen'],
  },
  {
    id: 'goat-of-the-year',
    name: 'GOAT of the Year',
    blurb: 'The greatest of all time. This year, anyway.',
    nominees: ['sam', 'gage', 'ian', 'griffin', 'hawkin'],
  },
  {
    id: 'bum-of-the-year',
    name: 'Bum of the Year',
    blurb: 'Zero plans, zero shame, maximum couch.',
    nominees: ['quinn', 'sam', 'gage', 'hawkin', 'morgan'],
  },
  {
    id: 'chad-of-the-year',
    name: 'Chad of the Year',
    blurb: 'Confidence level: off the charts.',
    nominees: ['quinn', 'sam', 'gage', 'hawkin', 'morgan'],
  },
  {
    id: 'tsundere-of-the-year',
    name: 'Tsundere of the Year',
    blurb: "Acts like they don't care. Absolutely cares.",
    nominees: ['griffin', 'gage', 'sam', 'ian'],
  },
  {
    id: 'crashout-of-the-year',
    name: 'Crashout of the Year',
    blurb: 'The meltdown heard around the group chat.',
    nominees: ['griffin', 'gage', 'sam', 'ian'],
  },
  {
    id: 'duo-of-the-year',
    name: 'Duo of the Year',
    blurb: 'Better together. Or at least louder.',
    nominees: ['sam-griffin', 'stephen-josh', 'hawkin-morgan', 'ian-gage'],
  },
  {
    id: 'rabbit-rabbi-of-the-year',
    name: 'Rabbit Rabbi of the Year',
    blurb: 'The big one. The one everyone came for.',
    nominees: ['gage', 'griffin', 'ian'],
  },
];

module.exports = { people, categories };
