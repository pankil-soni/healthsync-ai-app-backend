const Diagnosis = require('../models/diagnosis.model');
const User = require('../models/user.model');
const Doctor = require('../models/doctor.model');
const Patient = require('../models/patient.model');
const aiService = require('./ai.service');
const { AppError } = require('../middleware/error.middleware');

// Start a new diagnosis session
exports.startDiagnosis = async (patientId, symptomDescription) => {
    try {
        // Get patient details for context
        const patient = await Patient.findById(patientId);
        if (!patient) {
            throw new AppError('Patient not found', 404);
        }

        // Create new diagnosis
        const diagnosis = new Diagnosis({
            patientId,
            title: 'New Diagnosis',
            symptomDescription,
            conversationHistory: [
                {
                    role: 'patient',
                    message: symptomDescription,
                    timestamp: Date.now()
                }
            ],
            status: 'ongoing'
        });

        await diagnosis.save();

        // Generate initial AI response
        const patientHistory = formatPatientHistory(patient);
        const aiResponse = await aiService.medicalDiagnosis(symptomDescription, patientHistory);

        // Add AI response to conversation
        diagnosis.conversationHistory.push({
            role: 'ai',
            message: aiResponse,
            timestamp: Date.now()
        });

        await diagnosis.save();

        return diagnosis;
    } catch (error) {
        console.error('Start diagnosis error:', error);
        throw new AppError('Failed to start diagnosis session', 500);
    }
};

// Add message to diagnosis conversation
exports.addMessage = async (diagnosisId, message, role, attachments = []) => {
    try {
        // Get diagnosis
        const diagnosis = await Diagnosis.findById(diagnosisId);
        if (!diagnosis) {
            throw new AppError('Diagnosis not found', 404);
        }

        // Check if diagnosis is still ongoing
        if (diagnosis.status !== 'ongoing') {
            throw new AppError('This diagnosis session has been completed', 400);
        }

        // Add message to conversation
        diagnosis.conversationHistory.push({
            role,
            message,
            timestamp: Date.now(),
            attachments
        });

        await diagnosis.save();

        // If patient message, generate AI response
        if (role === 'patient') {
            // Get patient for context
            const patient = await Patient.findById(diagnosis.patientId);
            const patientHistory = formatPatientHistory(patient);

            // If attachments present, use vision API
            let aiResponse;
            if (attachments && attachments.length > 0) {
                const imageUrls = attachments.map(att => att.url);
                aiResponse = await aiService.generateVisionCompletion(message, imageUrls);
            } else {
                // Create context from conversation history
                const conversationContext = diagnosis.conversationHistory.map(msg => ({
                    role: msg.role,
                    message: msg.message
                }));

                aiResponse = await aiService.generateTextCompletion(conversationContext, {
                    temperature: 0.3
                });
            }

            // Add AI response to conversation
            diagnosis.conversationHistory.push({
                role: 'ai',
                message: aiResponse,
                timestamp: Date.now()
            });

            await diagnosis.save();
        }

        return diagnosis;
    } catch (error) {
        console.error('Add message error:', error);
        throw new AppError('Failed to add message to diagnosis', 500);
    }
};

// Complete initial AI diagnosis
exports.completeDiagnosis = async (diagnosisId) => {
    try {
        // Get diagnosis
        const diagnosis = await Diagnosis.findById(diagnosisId);
        if (!diagnosis) {
            throw new AppError('Diagnosis not found', 404);
        }

        // Get patient for context
        const patient = await Patient.findById(diagnosis.patientId);
        const patientHistory = formatPatientHistory(patient);

        // Generate summary
        const summary = await aiService.generateDiagnosisSummary(
            diagnosis.conversationHistory,
            patientHistory
        );

        // Update diagnosis with summary
        diagnosis.aiSummary = summary;

        // Generate test suggestions
        const testSuggestions = await aiService.suggestMedicalTests(summary, patientHistory);

        // Add suggested tests to diagnosis
        diagnosis.suggestedTests = testSuggestions.tests;

        // Get available doctors
        const doctors = await Doctor.find({ isActive: true }).limit(10);

        // Recommend doctor
        const doctorRecommendation = await aiService.recommendDoctor(summary, doctors);

        // Update with suggested doctor
        if (doctorRecommendation.recommendedDoctorId) {
            diagnosis.suggestedDoctor = {
                doctorId: doctorRecommendation.recommendedDoctorId,
                reason: doctorRecommendation.reason,
                isConfirmed: false
            };
        }

        // Update status
        diagnosis.status = 'pending_doctor_review';

        await diagnosis.save();

        return diagnosis;
    } catch (error) {
        console.error('Complete diagnosis error:', error);
        throw new AppError('Failed to complete diagnosis', 500);
    }
};

// Confirm/select doctor for diagnosis
exports.selectDoctor = async (diagnosisId, doctorId) => {
    try {
        // Get diagnosis
        const diagnosis = await Diagnosis.findById(diagnosisId);
        if (!diagnosis) {
            throw new AppError('Diagnosis not found', 404);
        }

        // Check if doctor exists
        const doctor = await Doctor.findById(doctorId);
        if (!doctor) {
            throw new AppError('Doctor not found', 404);
        }

        // Update diagnosis with selected doctor
        diagnosis.finalDoctorId = doctorId;

        // If this is the same as suggested doctor, mark as confirmed
        if (diagnosis.suggestedDoctor && diagnosis.suggestedDoctor.doctorId.toString() === doctorId.toString()) {
            diagnosis.suggestedDoctor.isConfirmed = true;
        }

        await diagnosis.save();

        return diagnosis;
    } catch (error) {
        console.error('Select doctor error:', error);
        throw new AppError('Failed to select doctor', 500);
    }
};

// Doctor approves diagnosis and tests
exports.approveDiagnosis = async (diagnosisId, doctorId, modifications = {}) => {
    try {
        // Get diagnosis
        const diagnosis = await Diagnosis.findById(diagnosisId);
        if (!diagnosis) {
            throw new AppError('Diagnosis not found', 404);
        }

        // Check if doctor exists
        const doctor = await Doctor.findById(doctorId);
        if (!doctor) {
            throw new AppError('Doctor not found', 404);
        }

        // Update diagnosis with doctor's modifications
        if (modifications.tests) {
            // Update test approvals
            modifications.tests.forEach(testMod => {
                const testIndex = diagnosis.suggestedTests.findIndex(
                    test => test._id.toString() === testMod.testId.toString()
                );

                if (testIndex !== -1) {
                    diagnosis.suggestedTests[testIndex].isApproved = testMod.isApproved;
                    diagnosis.suggestedTests[testIndex].approvedBy = doctorId;
                    diagnosis.suggestedTests[testIndex].approvedAt = Date.now();

                    if (testMod.reason) {
                        diagnosis.suggestedTests[testIndex].reason = testMod.reason;
                    }

                    if (testMod.priority) {
                        diagnosis.suggestedTests[testIndex].priority = testMod.priority;
                    }
                }
            });
        }

        // Add additional tests if provided
        if (modifications.additionalTests && Array.isArray(modifications.additionalTests)) {
            modifications.additionalTests.forEach(test => {
                diagnosis.suggestedTests.push({
                    name: test.name,
                    reason: test.reason || 'Added by doctor',
                    priority: test.priority || 'medium',
                    isApproved: true,
                    approvedBy: doctorId,
                    approvedAt: Date.now()
                });
            });
        }

        // Update doctor notes if provided
        if (modifications.doctorNotes) {
            // Add doctor notes as a message in the conversation
            diagnosis.conversationHistory.push({
                role: 'ai', // Using AI role for doctor's notes
                message: `Doctor's Notes: ${modifications.doctorNotes}`,
                timestamp: Date.now()
            });
        }

        // Set final doctor if not already set
        if (!diagnosis.finalDoctorId) {
            diagnosis.finalDoctorId = doctorId;
        }

        // Update status to pending reports if any tests are approved
        const hasApprovedTests = diagnosis.suggestedTests.some(test => test.isApproved);
        if (hasApprovedTests) {
            diagnosis.status = 'pending_reports';
        } else {
            diagnosis.status = 'completed';
        }

        await diagnosis.save();

        return diagnosis;
    } catch (error) {
        console.error('Approve diagnosis error:', error);
        throw new AppError('Failed to approve diagnosis', 500);
    }
};

// Get diagnosis details
exports.getDiagnosis = async (diagnosisId, userId, role) => {
    try {
        // Get diagnosis with populated fields
        const diagnosis = await Diagnosis.findById(diagnosisId)
            .populate('patientId', 'name')
            .populate('finalDoctorId', 'name specialization')
            .populate('suggestedDoctor.doctorId', 'name specialization');

        if (!diagnosis) {
            throw new AppError('Diagnosis not found', 404);
        }

        // Check authorization
        if (role === 'patient' && diagnosis.patientId._id.toString() !== userId.toString()) {
            throw new AppError('Not authorized to access this diagnosis', 403);
        }

        return diagnosis;
    } catch (error) {
        console.error('Get diagnosis error:', error);
        throw new AppError('Failed to get diagnosis details', 500);
    }
};

// Get all diagnoses for a patient
exports.getPatientDiagnoses = async (patientId, filters = {}) => {
    try {
        const query = { patientId };

        // Apply status filter if provided
        if (filters.status) {
            query.status = filters.status;
        }

        // Apply date range filter if provided
        if (filters.startDate && filters.endDate) {
            query.createdAt = {
                $gte: new Date(filters.startDate),
                $lte: new Date(filters.endDate)
            };
        }

        const diagnoses = await Diagnosis.find(query)
            .populate('finalDoctorId', 'name specialization')
            .sort({ createdAt: -1 })
            .select('-conversationHistory'); // Exclude conversation for list view

        return diagnoses;
    } catch (error) {
        console.error('Get patient diagnoses error:', error);
        throw new AppError('Failed to get patient diagnoses', 500);
    }
};

// Get all diagnoses for a doctor to review
exports.getDoctorPendingDiagnoses = async (doctorId) => {
    try {
        const pendingDiagnoses = await Diagnosis.find({
            $or: [
                { finalDoctorId: doctorId, status: 'pending_doctor_review' },
                { 'suggestedDoctor.doctorId': doctorId, status: 'pending_doctor_review' }
            ]
        })
            .populate('patientId', 'name gender dateOfBirth')
            .sort({ createdAt: -1 });

        return pendingDiagnoses;
    } catch (error) {
        console.error('Get doctor pending diagnoses error:', error);
        throw new AppError('Failed to get pending diagnoses for doctor', 500);
    }
};

// Helper function to format patient history
function formatPatientHistory(patient) {
    if (!patient) return '';

    let history = '';

    // Add basic info
    if (patient.dateOfBirth) {
        const age = calculateAge(patient.dateOfBirth);
        history += `Age: ${age} years. `;
    }

    if (patient.gender) {
        history += `Gender: ${patient.gender}. `;
    }

    // Add medical conditions
    if (patient.medicalHistory && patient.medicalHistory.length > 0) {
        history += 'Medical conditions: ';
        patient.medicalHistory.forEach((condition, index) => {
            history += condition.condition;
            if (index < patient.medicalHistory.length - 1) {
                history += ', ';
            }
        });
        history += '. ';
    }

    // Add allergies
    if (patient.allergies && patient.allergies.length > 0) {
        history += 'Allergies: ';
        patient.allergies.forEach((allergy, index) => {
            history += allergy;
            if (index < patient.allergies.length - 1) {
                history += ', ';
            }
        });
        history += '. ';
    }

    // Add health metrics
    if (patient.healthMetrics) {
        if (patient.healthMetrics.height) {
            history += `Height: ${patient.healthMetrics.height} cm. `;
        }

        if (patient.healthMetrics.weight) {
            history += `Weight: ${patient.healthMetrics.weight} kg. `;
        }

        if (patient.healthMetrics.bloodType) {
            history += `Blood type: ${patient.healthMetrics.bloodType}. `;
        }
    }

    return history;
}

// Helper function to calculate age
function calculateAge(birthDate) {
    const today = new Date();
    const dob = new Date(birthDate);
    let age = today.getFullYear() - dob.getFullYear();
    const monthDiff = today.getMonth() - dob.getMonth();

    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
        age--;
    }

    return age;
}