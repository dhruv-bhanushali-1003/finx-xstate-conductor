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
  async startWorkflow(workflowName = "loan-application-process-using-xstate") {
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

  async getAllPendingTasks() {
    try {
      const workflows = await this.searchWorkflows("loan-application-process-using-xstate");
      const pendingTasks = [];

      for (const workflow of workflows) {
        if (workflow.status === "RUNNING") {
          const workflowDetails = await this.getWorkflowStatus(workflow.workflowId);
          const uiTasks = workflowDetails.tasks.filter(
            (t) =>
              t.status === "SCHEDULED" &&
              (t.inputData?.ui_component === "BankReviewInfoScreen" ||
                t.inputData?.ui_component === "BankApprovalScreen")
          );
          
          uiTasks.forEach(task => {
            pendingTasks.push({
              workflowId: workflow.workflowId,
              taskId: task.taskId,
              taskType: task.taskDefName,
              uiComponent: task.inputData?.ui_component,
              customerData: task.inputData?.data || task.inputData?.additionalData || task.inputData?.initialData || {},
              createdTime: workflow.createTime,
              status: task.status
            });
          });
        }
      }
      
      return pendingTasks.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime));
    } catch (err) {
      console.error("getAllPendingTasks error:", err);
      return [];
    }
  },
};

// -------------------- XState Machine Definition --------------------
export const loanMachine = setup({
  actors: {
    loadTaskQueue: fromPromise(async () => {
      return await ConductorService.getAllPendingTasks();
    }),

    pollNextUiTask: fromPromise(async () => {
      // Search for loan workflows
      const workflows = await ConductorService.searchWorkflows(
        "loan-application-process-using-xstate"
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
  initial: "loadingQueue",
  context: {
    workflowId: null,
    currentTask: null,
    formData: {},
    error: null,
    taskQueue: [],
  },
  states: {
    loadingQueue: {
      invoke: {
        src: "loadTaskQueue",
        onDone: {
          target: "queueView",
          actions: assign({
            taskQueue: ({ event }) => event.output,
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

    queueView: {
      on: {
        PROCESS_NEXT: "polling",
        REFRESH_QUEUE: "loadingQueue",
      },
    },

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
        3000: "loadingQueue",
      },
    },

    error: {
      on: {
        RETRY: "polling",
      },
    },
  },
});

// -------------------- Components --------------------

function TaskQueueView({ taskQueue, onProcessNext, onRefresh }) {
  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <div className="flex justify-between items-center mb-6 border-b pb-3">
        <h2 className="text-2xl font-bold text-gray-800">New loan applications</h2>
        <button
          onClick={onRefresh}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition-colors"
        >
          Refresh
        </button>
      </div>
      
      {taskQueue.length === 0 ? (
        <div className="text-center py-8">
          <div className="text-gray-400 text-4xl mb-4">📋</div>
          <p className="text-gray-600">No pending tasks</p>
        </div>
      ) : (
        <>
          <div className="mb-4">
            <p className="text-sm text-gray-600">
              {taskQueue.length} task{taskQueue.length !== 1 ? 's' : ''} pending
            </p>
          </div>
          
          <div className="space-y-3 mb-6">
            {taskQueue.map((task, index) => (
              <div key={task.taskId} className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50">
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2 mb-2">
                      <span className="bg-blue-100 text-blue-800 text-xs px-2 py-1 rounded">
                        #{index + 1}
                      </span>
                      <span className="font-medium text-gray-900">
                        {task.uiComponent === 'BankReviewInfoScreen' ? 'Review Application' : 'Approval Decision'}
                      </span>
                    </div>
                    <div className="text-sm text-gray-600 space-y-1">
                      <p><strong>Customer:</strong> {task.customerData.fullName || 'N/A'}</p>
                      <p><strong>Email:</strong> {task.customerData.email || 'N/A'}</p>
                      <p><strong>Phone:</strong> {task.customerData.phone || 'N/A'}</p>
                      <p><strong>Loan Amount:</strong> {task.customerData.loanAmount || 'N/A'}</p>     
                    </div>
                  </div>
                  <div className="ml-4">
                    <span className={`px-2 py-1 text-xs rounded ${
                      task.status === 'SCHEDULED' ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-800'
                    }`}>
                      {task.status}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          
          <button
            onClick={onProcessNext}
            className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors shadow-md"
          >
            Process Next Task
          </button>
        </>
      )}
    </div>
  );
}

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
  const { currentTask, formData, error, taskQueue } = state.context;
  // No need to start workflow - connecting to existing one

  const handleUpdate = (data) => send({ type: "FORM_UPDATE", data });
  const handleSubmit = (data) => {
    console.log("Submitting data:", data);
    send({ type: "FORM_UPDATE", data });
    send({ type: "FORM_SUBMIT" });
  };
  
  const handleProcessNext = () => send({ type: "PROCESS_NEXT" });
  const handleRefreshQueue = () => send({ type: "REFRESH_QUEUE" });

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-8">
      <div className="max-w-4xl mx-auto px-4">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-800 mb-2">FinX Bank</h1>
          <p className="text-xl text-gray-600">Loan Officer Application</p>
        </div>

        {state.matches("loadingQueue") && (
          <div className="bg-white rounded-lg shadow-md p-8 text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
            <p className="text-gray-600">Loading loan applications...</p>
          </div>
        )}
        
        {state.matches("queueView") && (
          <TaskQueueView
            taskQueue={taskQueue}
            onProcessNext={handleProcessNext}
            onRefresh={handleRefreshQueue}
          />
        )}

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
