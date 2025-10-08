"use client"

// src/App.js
import React from "react";
import { useState } from "react";
import axios from "axios";
import { setup, assign, fromPromise } from "xstate";
import { useMachine } from "@xstate/react";
import { useForm } from "react-hook-form";

// -------------------- Conductor Service --------------------
const ConductorService = {
  async startWorkflow(workflowName = "loan-application-simple-2") {
    try {
      const res = await axios.post(`/api/proxy/workflow`, { name: workflowName });
      return { workflowId: res.data };
    } catch (err) {
      console.error("startWorkflow error:", err);
      throw err;
    }
  },

  async getWorkflowStatus(workflowId) {
    try {
      const res = await axios.get(`/api/proxy/workflow/${workflowId}`);
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
        `/api/proxy/tasks/poll/${taskType}?workerid=${workerId}`
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
      const res = await axios.post(`/api/proxy/tasks`, {
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

  async searchWorkflows(workflowType) {
    try {
      const res = await axios.get(
        `/api/proxy/workflow/search?start=0&size=15&sort=startTime%3ADESC&freeText=%2A&query=workflowType%20IN%20%28${workflowType}%29`
      );
      return res.data.results || [];
    } catch (err) {
      console.error("searchWorkflows error:", err);
      return [];
    }
  },
};

// -------------------- XState Machine Definition --------------------
export const loanMachine = setup({
  actors: {
    pollNextUiTask: fromPromise(async () => {
      // Search for loan workflows
      const workflows = await ConductorService.searchWorkflows(
        "loan-application-simple-2"
      );

      for (const workflow of workflows) {
        if (workflow.status === "RUNNING") {
          const workflowDetails = await ConductorService.getWorkflowStatus(
            workflow.workflowId
          );
          const uiTask = workflowDetails.tasks.find(
            (t) =>
              t.status === "SCHEDULED" &&
              (t.inputData?.ui_component === "BankReviewInfoScreen" ||
                t.inputData?.ui_component === "BankApprovalScreen")
          );

          if (uiTask) {
            const polled = await ConductorService.pollForTask(
              uiTask.taskDefName
            );
            if (polled) return polled;
          }
        }
      }

      return { status: "WAITING", task: null };
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
        input.currentTask.workflowInstanceId,
        input.currentTask.taskId,
        {
          formData: input.formData,
        }
      );
    }),
  },
}).createMachine({
  id: "loanApp",
  initial: "polling",
  context: {
    workflowId: null,
    currentTask: null,
    formData: {},
    error: null,
  },
  states: {
    polling: {
      invoke: {
        src: "pollNextUiTask",
        onDone: [
          {
            guard: ({ event }) => {
              console.log("Polled event:", event);
              return (
                event.output.task !== null && event.output.status !== "WAITING"
              );
            },
            target: "rendering",
            actions: assign({
              currentTask: ({ event }) => event.output,
              workflowId: ({ event }) => event.output.workflowInstanceId,
            }),
          },
          {
            target: "waitForPoll",
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
        5000: "polling",
      },
    },

    rendering: {
      on: {
        FORM_UPDATE: {
          actions: assign({
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
        onDone: "taskCompleted",
        onError: {
          target: "error",
          actions: assign({
            error: ({ event }) => event.error,
          }),
        },
      },
    },

    taskCompleted: {
      after: {
        3000: "polling",
      },
    },

    error: {
      on: {
        RETRY: "polling",
      },
    },
  },
});

// -------------------- Forms --------------------

function BankReviewInfoScreen({ currentTask, onSubmit }) {
  const applicationData = currentTask?.inputData || {};

  const handleConfirm = () => onSubmit({ needsMoreInfo: false });
  const handleRequestMoreInfo = () => onSubmit({ needsMoreInfo: true });

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <h2 className="text-2xl font-bold text-gray-800 mb-6 border-b pb-3">
        Bank Review - Application Information
      </h2>
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-6">
        <h3 className="text-lg font-medium text-gray-800 mb-3">
          Customer Application Details
        </h3>
        <pre className="text-sm text-gray-600 whitespace-pre-wrap">
          {JSON.stringify(applicationData.data, null, 2)}
        </pre>
      </div>
      <div className="flex space-x-4">
        <button
          onClick={handleConfirm}
          className="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors shadow-md"
        >
          Confirm Information
        </button>
        <button
          onClick={handleRequestMoreInfo}
          className="flex-1 bg-yellow-600 hover:bg-yellow-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors shadow-md"
        >
          Request Additional Information
        </button>
      </div>
    </div>
  );
}

function BankApprovalScreen({ currentTask, onSubmit }) {
  const applicationData = currentTask?.inputData?.additionalData
    ? currentTask.inputData.additionalData
    : currentTask?.inputData.initialData;
  const handleApprove = () => onSubmit({ approvalStatus: true });
  const handleReject = () => onSubmit({ approvalStatus: false });

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <h2 className="text-2xl font-bold text-gray-800 mb-6 border-b pb-3">
        Bank Review - Loan Approval Decision
      </h2>
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-6">
        <h3 className="text-lg font-medium text-gray-800 mb-3">
          Final Application Review
        </h3>
        <pre className="text-sm text-gray-600 whitespace-pre-wrap">
          {JSON.stringify(applicationData, null, 2)}
        </pre>
      </div>
      <div className="flex space-x-4">
        <button
          onClick={handleApprove}
          className="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors shadow-md"
        >
          Approve Loan
        </button>
        <button
          onClick={handleReject}
          className="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors shadow-md"
        >
          Reject Loan
        </button>
      </div>
    </div>
  );
}

// -------------------- Main App --------------------
function LoanApplication() {
  const [state, send] = useMachine(loanMachine);
  const { currentTask, formData, error } = state.context;
  // No need to start workflow - connecting to existing one

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
          <h1 className="text-4xl font-bold text-gray-800 mb-2">FinX Bank</h1>
          <p className="text-xl text-gray-600">Loan Officer Application</p>
        </div>

        {state.matches("polling") && (
          <div className="bg-white rounded-lg shadow-md p-8 text-center">
            <div className="animate-pulse h-4 bg-gray-200 rounded mb-4"></div>
            <p className="text-gray-600">
              Waiting for customer applications to review...
            </p>
          </div>
        )}
        {state.matches("waitForPoll") && (
          <div className="bg-white rounded-lg shadow-md p-8 text-center">
            <div className="animate-pulse h-4 bg-gray-200 rounded mb-4"></div>
            <p className="text-gray-600">
              Waiting for customer applications to review...
            </p>
          </div>
        )}
        {state.matches("rendering") && (
          <>
            {currentTask?.inputData?.ui_component ===
              "BankReviewInfoScreen" && (
              <BankReviewInfoScreen
                currentTask={currentTask}
                onSubmit={handleSubmit}
              />
            )}
            {currentTask?.inputData?.ui_component === "BankApprovalScreen" && (
              <BankApprovalScreen
                currentTask={currentTask}
                onSubmit={handleSubmit}
              />
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
        {state.matches("taskCompleted") && (
          <div className="p-6 bg-green-50 border border-green-200 rounded-lg text-center">
            <div className="text-green-600 text-4xl mb-4">✅</div>
            <h2 className="text-2xl font-bold text-green-800 mb-2">
              Task Completed Successfully!
            </h2>
            <p className="text-green-700 mb-4">
              Your review has been submitted.
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
