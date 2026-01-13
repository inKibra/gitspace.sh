import { describe, expect, it } from 'bun:test';
import {
  sanitizeForFileSystem,
  generateWorkspaceName,
  isValidWorkspaceName,
  isValidBranchName,
  extractRepoName,
} from './sanitize';

describe('sanitizeForFileSystem', () => {
  it('should convert slashes to hyphens', () => {
    expect(sanitizeForFileSystem('fix/bla-bla-blah')).toBe('fix-bla-bla-blah');
  });

  it('should handle feature branch patterns', () => {
    expect(sanitizeForFileSystem('feature/user-auth')).toBe('feature-user-auth');
  });

  it('should handle multiple slashes', () => {
    expect(sanitizeForFileSystem('feature/auth/oauth')).toBe('feature-auth-oauth');
  });

  it('should convert to lowercase', () => {
    expect(sanitizeForFileSystem('Fix/BLA-Blah')).toBe('fix-bla-blah');
  });

  it('should collapse multiple hyphens', () => {
    expect(sanitizeForFileSystem('fix//double-slash')).toBe('fix-double-slash');
  });

  it('should remove leading and trailing hyphens', () => {
    expect(sanitizeForFileSystem('/leading-slash')).toBe('leading-slash');
    expect(sanitizeForFileSystem('trailing-slash/')).toBe('trailing-slash');
  });

  it('should handle spaces', () => {
    expect(sanitizeForFileSystem('fix login bug')).toBe('fix-login-bug');
  });

  it('should handle special characters', () => {
    expect(sanitizeForFileSystem('fix!@#$%bug')).toBe('fix-bug');
  });

  it('should preserve underscores', () => {
    expect(sanitizeForFileSystem('fix_login_bug')).toBe('fix_login_bug');
  });

  it('should return empty string for input with no valid characters', () => {
    expect(sanitizeForFileSystem('!@#$%')).toBe('');
  });

  it('should limit length to 100 characters', () => {
    const longName = 'a'.repeat(150);
    expect(sanitizeForFileSystem(longName).length).toBe(100);
  });
});

describe('isValidWorkspaceName', () => {
  it('should accept valid names', () => {
    expect(isValidWorkspaceName('my-workspace')).toBe(true);
    expect(isValidWorkspaceName('workspace123')).toBe(true);
    expect(isValidWorkspaceName('my_workspace')).toBe(true);
  });

  it('should reject names with spaces', () => {
    expect(isValidWorkspaceName('my workspace')).toBe(false);
  });

  it('should reject names with slashes', () => {
    expect(isValidWorkspaceName('fix/bug')).toBe(false);
  });

  it('should reject empty names', () => {
    expect(isValidWorkspaceName('')).toBe(false);
  });

  it('should reject names starting or ending with hyphens', () => {
    expect(isValidWorkspaceName('-workspace')).toBe(false);
    expect(isValidWorkspaceName('workspace-')).toBe(false);
  });
});

describe('isValidBranchName', () => {
  it('should accept valid branch names with slashes', () => {
    expect(isValidBranchName('fix/bla-bla-blah')).toBe(true);
    expect(isValidBranchName('feature/user-auth')).toBe(true);
  });

  it('should accept simple branch names', () => {
    expect(isValidBranchName('main')).toBe(true);
    expect(isValidBranchName('develop')).toBe(true);
  });

  it('should reject names with consecutive dots', () => {
    expect(isValidBranchName('branch..name')).toBe(false);
  });

  it('should reject names starting or ending with slash', () => {
    expect(isValidBranchName('/branch')).toBe(false);
    expect(isValidBranchName('branch/')).toBe(false);
  });

  it('should reject names with consecutive slashes', () => {
    expect(isValidBranchName('branch//name')).toBe(false);
  });

  it('should reject names ending with .lock', () => {
    expect(isValidBranchName('branch.lock')).toBe(false);
  });

  it('should reject names with special characters', () => {
    expect(isValidBranchName('branch~name')).toBe(false);
    expect(isValidBranchName('branch^name')).toBe(false);
    expect(isValidBranchName('branch:name')).toBe(false);
    expect(isValidBranchName('branch?name')).toBe(false);
    expect(isValidBranchName('branch*name')).toBe(false);
    expect(isValidBranchName('branch[name')).toBe(false);
    expect(isValidBranchName('branch\\name')).toBe(false);
  });

  it('should reject components starting with dot', () => {
    expect(isValidBranchName('.hidden')).toBe(false);
    expect(isValidBranchName('feature/.hidden')).toBe(false);
  });

  it('should reject names starting with dash', () => {
    expect(isValidBranchName('-branch')).toBe(false);
  });
});

describe('generateWorkspaceName', () => {
  it('should combine identifier and sanitized title', () => {
    expect(generateWorkspaceName('ENG-123', 'Fix Login Bug!')).toBe('eng-123-fix-login-bug');
  });

  it('should handle spaces in title', () => {
    expect(generateWorkspaceName('FEAT-456', 'Add Dark Mode')).toBe('feat-456-add-dark-mode');
  });
});

describe('extractRepoName', () => {
  it('should extract repo name from owner/repo format', () => {
    expect(extractRepoName('myorg/my-app')).toBe('my-app');
  });

  it('should handle simple repo name', () => {
    expect(extractRepoName('my-app')).toBe('my-app');
  });
});
