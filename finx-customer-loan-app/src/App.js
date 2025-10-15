// src/App.js
import React from "react";
import { useState, useEffect } from "react";
import axios from "axios";
import { setup, assign, fromPromise } from "xstate";
import { useMachine } from "@xstate/react";
import { useForm } from "react-hook-form";
import { Form } from 'react-formio';
import 'formiojs/dist/formio.full.css';
import { Formio } from 'formiojs';

Formio.setBaseUrl('http://3.110.81.211');

// -------------------- Conductor Service --------------------
const ConductorService = {
  async startWorkflow(workflowName = "Finx Bank loan-application-process") {
    try {
      const res = await axios.post(`https://base-api.fincuro.in/gateway/ui-workflow/api/workflow`, { name: workflowName });
      return { workflowId: res.data };
    } catch (err) {
      console.error("startWorkflow error:", err);
      throw err;
    }
  },

  async getApplicationByUUID(uuid) {
    try {
      console.log(uuid);
      const res = await axios.get(
        `https://base-api.fincuro.in/gateway/ui-workflow/api/application-data/${uuid}`
      );
      console.log(res.data);
      return res.data;
    } catch (err) {
      console.error("getApplicationByUUID error:", err);
      throw err;
    }
  },

  async getWorkflowStatus(workflowId) {
    try {
      const res = await axios.get(`https://base-api.fincuro.in/gateway/ui-workflow/api/workflow/${workflowId}`);
      return res.data;
    } catch (err) {
      console.error("getWorkflowStatus error:", err);
      throw err;
    }
  },

  async pollForTask(taskType, workerId = "loan-ui-worker") {
    try {
      console.log("Polling for task:", taskType);
      const res = await axios.get(
        `https://base-api.fincuro.in/gateway/ui-workflow/api/tasks/poll/${taskType}`,
        { params: { workerid: workerId } }
      );
      if (!res.data || !res.data.taskType) return null;
      return res.data;
    } catch (err) {
      console.error("pollForTask error:", err);
      throw err;
    }
  },

  async completeTask(workflowInstanceId, taskId, outputData) {
    try {
      console.log("Completing task:", taskId, "with data:", outputData);
      const res = await axios.post(`https://base-api.fincuro.in/gateway/ui-workflow/api/tasks`, {
        taskId,
        workflowInstanceId,
        status: "COMPLETED",
        outputData,
      });
      return res.data;
    } catch (err) {
      console.error("completeTask error:", err);
      throw err;
    }
  },
};

// -------------------- XState Machine Definition --------------------
export const loanMachine = setup({
  actors: {
    startWorkflow: fromPromise(() => ConductorService.startWorkflow()),

    pollNextUiTask: fromPromise(async ({ input }) => {
      const workflow = await ConductorService.getWorkflowStatus(
        input.workflowId
      );
      if (workflow.status !== "RUNNING") {
        return { status: workflow.status, task: null };
      }
      const nextUiTask = workflow.tasks.find(
        (t) =>
          t.status === "SCHEDULED" &&
          t.inputData?.ui_component !== "BankReviewInfoScreen" &&
          t.inputData?.ui_component !== "BankApprovalScreen"
      );
      if (!nextUiTask) {
        console.warn("No UI task found in workflow:", input.workflowId);
        return { status: workflow.status, task: null };
      }
      const polled = await ConductorService.pollForTask(nextUiTask.taskDefName);
      if (!polled?.inputData?.ui_component) {
        console.warn("Polled task is not UI:", polled?.taskDefName);
        return { status: workflow.status, task: null };
      }
      console.log("Current UI task:", polled?.inputData?.ui_component);
      return polled;
    }),

    validate: fromPromise(({ input }) => {
      const data = input.formData || {};
      const missing = Object.entries(data).filter(
        ([_, v]) => v === null || v === undefined || v === ""
      );
      if (missing.length) throw new Error("Please fill all fields.");
      return true;
    }),

    submitTask: fromPromise(({ input }) => {
      if (!input.currentTask) throw new Error("No task to submit");
      return ConductorService.completeTask(
        input.workflowId,
        input.currentTask.taskId,
        {
          formData: input.formData,
        }
      );
    }),
  },
}).createMachine({
  id: "loanApp",
  initial: "idle",
  context: {
    workflowId: null,
    currentTask: null,
    formData: {},
    error: null,
  },
  states: {
    idle: {
      on: { 
        FORM_UPDATE: {
          actions: assign({
            workflowId: ({ context, event }) => 
              (event.data || event).workflowId || context.workflowId,
            formData: ({ context, event }) => ({
              ...context.formData,
              ...(event.data || event),
            }),
          }),
        },
        START: [
          {
            guard: ({ context }) => {
              console.log("Guard check - context.workflowId:", context.workflowId);
              console.log("Guard check - context.formData.workflowId:", context.formData?.workflowId);
              return context.workflowId;
            },
            target: "polling"
          },
          {
            target: "starting"
          }
        ]
      },
    },

    starting: {
      invoke: {
        src: "startWorkflow",
        onDone: {
          target: "polling",
          actions: assign({
            workflowId: ({ event }) => event.output.workflowId,
            formData: ({ context, event }) => ({
              ...context.formData,
              workflowId: event.output.workflowId,
            }),
          }),
        },
        onError: {
          target: "error",
          actions: assign({
            error: ({ event }) => event.error,
          }),
        },
      },
    },

    polling: {
      invoke: {
        src: "pollNextUiTask",
        input: ({ context }) => ({ workflowId: context.workflowId }),
        onDone: [
          {
            guard: ({ event }) => {
              console.log("Polled event:", event);
              return event.output.task !== null;
            },
            target: "rendering",
            actions: assign({
              currentTask: ({ event }) => event.output,
            }),
          },
          {
            guard: ({ event }) => event.output.status === "COMPLETED",
            target: "completed",
          },
          {
            guard: ({ event }) =>
              ["FAILED", "TERMINATED", "TIMED_OUT"].includes(
                event.output.status
              ),
            target: "error",
            actions: assign({
              error: ({ event }) =>
                `Workflow ended with status: ${event.output.status}`,
            }),
          },
          {
            target: "waitForPoll", // fallback if workflow is still running but no task yet
          },
        ],
        onError: {
          target: "error",
          actions: assign({
            error: ({ event }) => event.error,
          }),
        },
      },
    },

    waitForPoll: {
      after: {
        3000: "polling",
      },
    },

    rendering: {
      on: {
        FORM_UPDATE: {
          actions: assign({
            workflowId: ({ context, event }) => 
              (event.data || event).workflowId || context.workflowId,
            formData: ({ context, event }) => ({
              ...context.formData,
              ...(event.data || event),
            }),
          }),
        },
        FORM_SUBMIT: "validating",
      },
    },

    validating: {
      invoke: {
        src: "validate",
        input: ({ context }) => context,
        onDone: "submitting",
        onError: {
          target: "rendering",
          actions: assign({
            error: ({ event }) => event.error,
          }),
        },
      },
    },

    submitting: {
      invoke: {
        src: "submitTask",
        input: ({ context }) => context,
        onDone: "polling",
        onError: {
          target: "error",
          actions: assign({
            error: ({ event }) => event.error,
          }),
        },
      },
    },

    completed: {
      type: "final",
    },

    error: {
      on: {
        RETRY: "polling",
      },
    },
  },
});

async function loginAndGetToken() {
  const response = await fetch('http://3.110.81.211/user/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      data: {
        email: 'satish@fincuro.9on.in',
        password: 'Satish@123456'
      }
    })
  });

  const token = response.headers.get('x-jwt-token');
  Formio.setToken(token); 
}


// -------------------- Forms --------------------

// Commented out original PersonalInfoForm
/*
function PersonalInfoForm({ onUpdate, onSubmit, formData }) {
  const { register, handleSubmit, watch } = useForm();
  const [agreed, setAgreed] = useState(false);

  React.useEffect(() => {
    const subscription = watch((values) => onUpdate(values));
    return () => subscription; // React Hook Form v7+ does not need unsubscribe
  }, [watch, onUpdate]);

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <h2 className="text-2xl font-bold text-gray-800 mb-6 border-b pb-3">
        Personal Information
      </h2>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Full Name
          </label>
          <input
            {...register("fullName")}
            className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Email
          </label>
          <input
            {...register("email")}
            type="email"
            className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Phone
          </label>
          <input
            {...register("phone")}
            className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Loan Amount
          </label>
          <input
            {...register("loanAmount")}
            className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
          />
        </div>
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
            <p className="text-sm text-gray-600 mb-3">
              <strong>Disclaimer:</strong> By proceeding, you confirm that the
              information provided above is true and accurate to the best of your
              knowledge. Any false or misleading details may affect your loan
              application process.
            </p>
            <label className="flex items-center space-x-2">
              <input
                type="checkbox"
                checked={agreed}
                onChange={() => setAgreed(!agreed)}
                className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
              />
              <span className="text-sm text-gray-700">
                I have read and agree to the above disclaimer.
              </span>
            </label>
          </div>
        <button
          type="submit"
          disabled={!agreed}
          className={`w-full font-semibold py-3 px-6 rounded-lg transition-colors shadow-md ${
            (agreed)
              ? "bg-indigo-600 hover:bg-indigo-700 text-white"
              : "bg-gray-300 text-gray-500 cursor-not-allowed"
          }`}
        >
          Next
        </button>
      </form>
    </div>
  );
}
*/

// New PersonalInfoForm using form-io react package
function PersonalInfoForm({ onUpdate, onSubmit, formData }) {
  return (
    <div className="max-w-lg mx-auto bg-white p-6 rounded-xl shadow-md">
      <Form
        src="http://3.110.81.211/form/68ee1dd19bd3200d522395c8"
        options={{ readOnly: false }}
        onSubmit={(submission) => {
          onUpdate(submission.data);
          onSubmit(submission.data);
        }}
      />
    </div>
  );
}

function FinancialInfoForm({ onUpdate, onSubmit }) {
  const { register, handleSubmit, watch } = useForm();

  React.useEffect(() => {
    const subscription = watch((values) => onUpdate(values));
    return () => subscription;
  }, [watch, onUpdate]);

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <h2 className="text-2xl font-bold text-gray-800 mb-6 border-b pb-3">
        Financial Information
      </h2>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Monthly Income
          </label>
          <input
            {...register("income")}
            className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Existing Loans
          </label>
          <input
            {...register("existingLoan")}
            type="number"
            className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
          />
        </div>
        <button
          type="submit"
          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors shadow-md"
        >
          Next
        </button>
      </form>
    </div>
  );
}

function EmploymentInfoForm({ onUpdate, onSubmit }) {
  const { register, handleSubmit, watch } = useForm();

  React.useEffect(() => {
    const subscription = watch((values) => onUpdate(values));
    return () => subscription;
  }, [watch, onUpdate]);

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <h2 className="text-2xl font-bold text-gray-800 mb-6 border-b pb-3">
        Employment Information
      </h2>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Employment Type
          </label>
          <select
            {...register("employmentType")}
            className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
          >
            <option value="Salaried">Salaried</option>
            <option value="Self-Employed">Self-Employed</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Employer / Business Name
          </label>
          <input
            {...register("employerName")}
            className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Years of Experience
          </label>
          <input
            {...register("experience")}
            type="number"
            className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
          />
        </div>

        <button
          type="submit"
          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors shadow-md"
        >
          Next
        </button>
      </form>
    </div>
  );
}

function AdditionalInfoForm({ onUpdate, onSubmit }) {
  const { register, handleSubmit, watch } = useForm();

  React.useEffect(() => {
    const subscription = watch((values) => onUpdate(values));
    return () => subscription;
  }, [watch, onUpdate]);

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <h2 className="text-2xl font-bold text-gray-800 mb-6 border-b pb-3">
        Additional Information for Self-Employed
      </h2>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Business Type
          </label>
          <input
            {...register("businessType")}
            className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Annual Business Revenue
          </label>
          <input
            {...register("businessRevenue")}
            type="number"
            className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Tax ID / Business Registration Number
          </label>
          <input
            {...register("taxId")}
            className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
          />
        </div>
        <button
          type="submit"
          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors shadow-md"
        >
          Submit
        </button>
      </form>
    </div>
  );
}

function ReviewComponent({ formData, onSubmit }) {
  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <h2 className="text-2xl font-bold text-gray-800 mb-6 border-b pb-3">
        Review & Submit
      </h2>
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-6">
        <h3 className="text-lg font-medium text-gray-800 mb-3">
          Application Summary
        </h3>
        <pre className="text-sm text-gray-600 whitespace-pre-wrap">
          {JSON.stringify(formData, null, 2)}
        </pre>
      </div>
      <button
        onClick={onSubmit}
        className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors shadow-md"
      >
        Submit Application
      </button>
    </div>
  );
}

// -------------------- Main App --------------------
function LoanApplication() {
  const [state, send] = useMachine(loanMachine);
  const { currentTask, formData, error } = state.context;
  const [token, setToken] = useState(null);

  useEffect(() => {
    loginAndGetToken().then(setToken);
    const urlParams = new URLSearchParams(window.location.search);
    const uuid = urlParams.get('uuid');
    
    if (uuid) {
      console.log("Loading existing application with UUID:", uuid);
      loadExistingApplication(uuid);
    } else {
      send({ type: "START" });
    }
  }, [send]);

  const loadExistingApplication = async (uuid) => {
    try {
      const applicationData = await ConductorService.getApplicationByUUID(uuid);
      console.log("Loaded application data:", applicationData);
      
      // First update the context with existing data
      send({ 
        type: "FORM_UPDATE", 
        data: applicationData.formData
      });
      
      // Small delay to ensure context is updated before START
      setTimeout(() => {
        console.log("Starting with existing workflowId:", applicationData.formData.workflowId);
        send({ type: "START" });
      }, 1000);
    } catch (error) {
      console.error('Failed to load application:', error);
      send({ type: "START" });
    }
  };

  const handleUpdate = (data) => send({ type: "FORM_UPDATE", data });
  const handleSubmit = (data) => {
    console.log("Submitting data:", data);
    send({ type: "FORM_UPDATE", data });
    send({ type: "FORM_SUBMIT" });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-8">
      <div className="max-w-4xl mx-auto px-4">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-800 mb-2">FinX</h1>
          <p className="text-xl text-gray-600">Customer Loan Application</p>
        </div>

        {state.matches("starting") && (
          <div className="bg-white rounded-lg shadow-md p-8 text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
            <p className="text-gray-600">Starting workflow...</p>
          </div>
        )}
        {state.matches("polling") && (
          <div className="bg-white rounded-lg shadow-md p-8 text-center">
            <div className="animate-pulse h-4 bg-gray-200 rounded mb-4"></div>
            <p className="text-gray-600">Waiting for next UI task...</p>
          </div>
        )}
        {state.matches("waitForPoll") && (
          <div className="p-6 bg-green-50 border border-green-200 rounded-lg text-center">
            <div className="text-green-600 text-4xl mb-4">✅</div>
            <h2 className="text-2xl font-bold text-green-800 mb-2">
              Thank You for Your Application!
            </h2>
            <p className="text-green-700 mb-4">
              We have received your loan application and it is now being
              processed.
            </p>
            <p className="text-green-600">
              We will get back to you soon with an update on your application
              status.
            </p>
          </div>
        )}
        {state.matches("rendering") && (
          <>
            {currentTask?.inputData?.ui_component === "PersonalInfoForm" && (
              <PersonalInfoForm
                onUpdate={handleUpdate}
                onSubmit={handleSubmit}
                formData={formData}
              />
            )}
            {currentTask?.inputData?.ui_component === "FinancialInfoForm" && (
              <FinancialInfoForm
                onUpdate={handleUpdate}
                onSubmit={handleSubmit}
              />
            )}
            {currentTask?.inputData?.ui_component === "EmploymentInfoForm" && (
              <EmploymentInfoForm
                onUpdate={handleUpdate}
                onSubmit={handleSubmit}
              />
            )}
            {currentTask?.inputData?.ui_component === "AdditionalInfoForm" && (
              <AdditionalInfoForm
                onUpdate={handleUpdate}
                onSubmit={handleSubmit}
              />
            )}
            {currentTask?.inputData?.ui_component === "ReviewSubmitScreen" && (
              <ReviewComponent formData={formData} onSubmit={handleSubmit} />
            )}
          </>
        )}

        {state.matches("validating") && (
          <div className="bg-white rounded-lg shadow-md p-8 text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
            <p className="text-gray-600">Validating...</p>
          </div>
        )}
        {state.matches("submitting") && (
          <div className="bg-white rounded-lg shadow-md p-8 text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
            <p className="text-gray-600">Submitting task...</p>
          </div>
        )}
        {state.matches("completed") && (
          <div className="p-6 bg-green-50 border border-green-200 rounded-lg text-center">
            <div className="text-green-600 text-4xl mb-4">✅</div>
            <h2 className="text-2xl font-bold text-green-800 mb-2">
              Thank You for Your Application!
            </h2>
            <p className="text-green-700 mb-4">
              We have received your loan application and it is now being
              processed.
            </p>
            <p className="text-green-600">
              We will get back to you soon with an update on
              your application status.
            </p>
          </div>
        )}

        {state.matches("error") && (
          <div className="bg-white rounded-lg shadow-md p-6">
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-center mb-3">
                <div className="text-red-500 text-xl mr-2">⚠️</div>
                <h3 className="text-lg font-semibold text-red-800">Error</h3>
              </div>
              <p className="text-red-700 mb-4">{String(error)}</p>
              <button
                onClick={() => send({ type: "RETRY" })}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors"
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default LoanApplication;
