
import { User, Interaction, PDFMetadata, UserRole, StudentStatus } from '../types.ts';

const USERS_KEY = 'murshid_users_v4'; // Incremented for clean migration to new profiling logic
const CURRENT_USER_ID_KEY = 'murshid_current_user_id';

/**
 * Normalizes text to extract core conceptual tokens.
 * Helps in identifying when a student is stuck on the same subject even with different phrasing.
 */
const normalizeTopic = (text: string): string => {
  const stopWords = new Set(['what', 'is', 'the', 'how', 'does', 'can', 'you', 'tell', 'me', 'about', 'explain', 'definition', 'of']);
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word))
    .sort() // Sorting helps identify same-word queries in different orders
    .slice(0, 3)
    .join('_') || 'general_concept';
};

export const storageService = {
  getUsers: (): Record<string, User> => {
    const data = localStorage.getItem(USERS_KEY);
    return data ? JSON.parse(data) : {};
  },

  saveUser: (user: User) => {
    const users = storageService.getUsers();
    users[user.id] = user;
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
  },

  getUser: (id: string): User | null => {
    const users = storageService.getUsers();
    return users[id] || null;
  },

  getAllStudents: (): User[] => {
    const users = storageService.getUsers();
    return Object.values(users).filter(u => u.role === UserRole.STUDENT);
  },

  login: (email: string, name: string, role: UserRole, linkedId?: string): User => {
    const id = email.toLowerCase().trim().replace(/[^a-z0-9]/g, '_');
    const users = storageService.getUsers();
    let user = users[id];

    if (user) {
      if (user.name !== name) user.name = name;
      user.role = role;
      if (role === UserRole.PARENT && linkedId) user.childId = linkedId;
      localStorage.setItem(CURRENT_USER_ID_KEY, id);
      storageService.saveUser(user);
      return user;
    }

    const newUser: User = {
      id,
      name: name.trim(),
      email: email.toLowerCase().trim(),
      role,
      childId: role === UserRole.PARENT ? linkedId : undefined,
      uploadedTextbooks: [],
      history: [],
      weakAreas: [],
      strongAreas: [],
      status: 'AVERAGE',
      aiInsightSummary: 'Establishing learning baseline. Awaiting initial student interactions...',
      conceptAttempts: {}
    };

    storageService.saveUser(newUser);
    localStorage.setItem(CURRENT_USER_ID_KEY, id);
    return newUser;
  },

  getCurrentUser: (): User | null => {
    const id = localStorage.getItem(CURRENT_USER_ID_KEY);
    if (!id) return null;
    return storageService.getUser(id);
  },

  logout: () => {
    localStorage.removeItem(CURRENT_USER_ID_KEY);
  },

  // Fix: Add addTextbook method to persist uploaded textbooks
  addTextbook: (userId: string, pdf: PDFMetadata) => {
    const user = storageService.getUser(userId);
    if (!user) return;
    user.uploadedTextbooks.push(pdf);
    storageService.saveUser(user);
  },

  addInteraction: (userId: string, interaction: Interaction) => {
    const user = storageService.getUser(userId);
    if (!user) return;

    // 1. Update history (most recent first)
    user.history = [interaction, ...user.history].slice(0, 100);
    
    // 2. Profile using conceptual normalization
    const conceptKey = normalizeTopic(interaction.question);
    user.conceptAttempts[conceptKey] = (user.conceptAttempts[conceptKey] || 0) + 1;

    // 3. Check for exact phrasing repetition (strongest signal of confusion)
    const exactPhrasingCount = user.history.filter(h => 
      h.question.toLowerCase().trim() === interaction.question.toLowerCase().trim()
    ).length;

    // 4. Identify Weak vs Strong Areas
    const concepts = Object.keys(user.conceptAttempts);
    const criticalGaps = concepts.filter(c => user.conceptAttempts[c] >= 3);
    const growingFriction = concepts.filter(c => user.conceptAttempts[c] === 2);
    const diverseConcepts = concepts.length;

    user.weakAreas = criticalGaps.map(c => c.replace(/_/g, ' '));
    // Strong areas are defined as topics explored with only 1 interaction after at least 10 total interactions
    user.strongAreas = user.history.length > 10 
      ? concepts.filter(c => user.conceptAttempts[c] === 1).map(c => c.replace(/_/g, ' '))
      : [];

    // 5. Sophisticated Profiling Logic
    const totalQuestions = user.history.length;

    if (criticalGaps.length >= 1 || exactPhrasingCount >= 2) {
      // Transition to NEEDS_IMPROVEMENT if stuck on any one concept or repeating exact questions
      user.status = 'NEEDS_IMPROVEMENT';
      
      if (exactPhrasingCount >= 2) {
        user.aiInsightSummary = `CRITICAL: Student is repeating the exact same question. There is a fundamental cognitive block regarding "${interaction.question}". Re-explaining using simpler analogies or visual aids is mandatory.`;
      } else {
        const topGap = criticalGaps[0].replace(/_/g, ' ');
        user.aiInsightSummary = `Student is stuck on "${topGap}" with ${user.conceptAttempts[criticalGaps[0]]} repeated inquiries. This suggests a conceptual mismatch between the material and the student's current understanding.`;
      }
    } else if (totalQuestions >= 6 && diverseConcepts >= 5 && exactPhrasingCount === 1) {
      // Transition to GOOD if student covers many topics with high efficiency
      user.status = 'GOOD';
      user.aiInsightSummary = `Excellent progress. Student shows high variety in questions and quickly grasps concepts without needing redundant clarification. Learning efficiency is currently optimal.`;
    } else if (growingFriction.length >= 2 || (totalQuestions > 3 && diverseConcepts < 2)) {
      // AVERAGE is for steady but slightly repetitive or narrow learning
      user.status = 'AVERAGE';
      user.aiInsightSummary = `Steady pace. Some minor friction detected in "${growingFriction[0]?.replace(/_/g, ' ') || 'core concepts'}". Student is maintaining a standard learning curve.`;
    } else {
      user.status = 'AVERAGE';
      user.aiInsightSummary = `Initial engagement looks healthy. Monitoring conceptual variety and response retention as the session progresses.`;
    }

    storageService.saveUser(user);
  }
};
