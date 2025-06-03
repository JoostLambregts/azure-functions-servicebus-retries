module.exports = {
  extends: [
    '@commitlint/config-conventional'
  ],
  rules: {
    'type-enum': [2, 'always', ['build', 'other', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test']],
    'footer-empty': [2, 'never'],
    'footer-min-length': [2, 'always', 5],
    'body-max-line-length': [1, 'always', 80],
    'scope-case': [2, 'always', 'upper-case'],
    'scope-empty': [2, 'never'],
    'references-empty': [2, 'never'],
    'subject-case': [2, 'always', 'sentence-case']
  }
}
