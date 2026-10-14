export interface ErrorDetail {
  field?: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorCode: string,
    message: string,
    public readonly details?: ErrorDetail[],
    public readonly isOperational = true,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', errorCode = 'BAD_REQUEST', details?: ErrorDetail[]) {
    super(400, errorCode, message, details);
  }
}
export class ValidationError extends AppError {
  constructor(details: ErrorDetail[], message = 'Validation failed') {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', errorCode = 'UNAUTHORIZED') {
    super(401, errorCode, message);
  }
}
export class ForbiddenError extends AppError {
  constructor(
    message = 'You do not have permission to perform this action',
    errorCode = 'FORBIDDEN',
  ) {
    super(403, errorCode, message);
  }
}
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', errorCode = 'NOT_FOUND') {
    super(404, errorCode, message);
  }
}
export class ConflictError extends AppError {
  constructor(message = 'Conflict', errorCode = 'CONFLICT') {
    super(409, errorCode, message);
  }
}
export class TooManyRequestsError extends AppError {
  constructor(
    message = 'Too many requests, please try again later',
    public retryAfterSeconds?: number,
  ) {
    super(429, 'RATE_LIMITED', message);
  }
}

// Business errors (used by later phases; defined now so error codes stay stable)
export class NurseNotAvailableError extends AppError {
  constructor(message = 'Nurse is not available for the requested time', details?: ErrorDetail[]) {
    super(409, 'NURSE_NOT_AVAILABLE', message, details);
  }
}
export class BookingConflictError extends AppError {
  constructor(message = 'The requested time overlaps another booking') {
    super(409, 'BOOKING_CONFLICT', message);
  }
}
export class InvalidBookingStateError extends AppError {
  constructor(message = 'Invalid booking state transition') {
    super(422, 'INVALID_BOOKING_STATE', message);
  }
}
export class PaymentFailedError extends AppError {
  constructor(message = 'Payment failed') {
    super(402, 'PAYMENT_FAILED', message);
  }
}
export class RefundFailedError extends AppError {
  constructor(message = 'Refund failed') {
    super(422, 'REFUND_FAILED', message);
  }
}
export class DocumentNotVerifiedError extends AppError {
  constructor(message = 'Required documents are not verified') {
    super(422, 'DOCUMENT_NOT_VERIFIED', message);
  }
}
export class InsufficientBalanceError extends AppError {
  constructor(message = 'Insufficient balance') {
    super(422, 'INSUFFICIENT_BALANCE', message);
  }
}
