import { Router } from 'express';
import medicalRefactored from './medicalRefactored';

// Create medical routes using the refactored modular components
export default function medicalRoutes(): Router {
    return medicalRefactored();
}

// Export the routes function for direct use
export { medicalRoutes };
